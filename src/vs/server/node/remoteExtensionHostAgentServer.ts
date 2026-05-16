/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from "os";
import * as fs from "fs";
import type * as http from "http";
import * as net from "net";
import { createRequire } from "node:module";
import { performance } from "perf_hooks";
import * as url from "url";
import { VSBuffer } from "../../base/common/buffer.js";
import { CharCode } from "../../base/common/charCode.js";
import {
	isSigPipeError,
	onUnexpectedError,
	setUnexpectedErrorHandler,
} from "../../base/common/errors.js";
import { isEqualOrParent } from "../../base/common/extpath.js";
import { Disposable, DisposableStore } from "../../base/common/lifecycle.js";
import {
	connectionTokenQueryName,
	FileAccess,
	getServerProductSegment,
	Schemas,
} from "../../base/common/network.js";
import { dirname, join } from "../../base/common/path.js";
import * as perf from "../../base/common/performance.js";
import * as platform from "../../base/common/platform.js";
import {
	createRegExp,
	escapeRegExpCharacters,
} from "../../base/common/strings.js";
import { URI } from "../../base/common/uri.js";
import { generateUuid } from "../../base/common/uuid.js";
import { getOSReleaseInfo } from "../../base/node/osReleaseInfo.js";
import { findFreePort } from "../../base/node/ports.js";
import {
	addUNCHostToAllowlist,
	disableUNCAccessRestrictions,
} from "../../base/node/unc.js";
import { PersistentProtocol } from "../../base/parts/ipc/common/ipc.net.js";
import {
	NodeSocket,
	upgradeToISocket,
	WebSocketNodeSocket,
} from "../../base/parts/ipc/node/ipc.net.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../platform/log/common/log.js";
import { IProductService } from "../../platform/product/common/productService.js";
import {
	ConnectionType,
	ConnectionTypeRequest,
	ErrorMessage,
	HandshakeMessage,
	IRemoteExtensionHostStartParams,
	ITunnelConnectionStartParams,
	SignRequest,
} from "../../platform/remote/common/remoteAgentConnection.js";
import { RemoteAgentConnectionContext } from "../../platform/remote/common/remoteAgentEnvironment.js";
import { ITelemetryService } from "../../platform/telemetry/common/telemetry.js";
import { ExtensionHostConnection } from "./extensionHostConnection.js";
import { ManagementConnection } from "./remoteExtensionManagement.js";
import {
	determineServerConnectionToken,
	ServerConnectionToken,
	ServerConnectionTokenParseError,
	ServerConnectionTokenType,
} from "./serverConnectionToken.js";
import {
	IServerEnvironmentService,
	ServerParsedArgs,
} from "./serverEnvironmentService.js";
import { setupServerServices, SocketServer } from "./serverServices.js";
import {
	CacheControl,
	serveError,
	serveFile,
	WebClientServer,
} from "./webClientServer.js";
import * as nourlmsAuth from "./nourlmsAuth.js";
import { handleNourlmsApiProxy } from "./nourlmsApiProxy.js";
import { handleNourlmsAiProxy } from "./nourlmsAiProxy.js";
import * as nodeHttp from "http";
import * as nodePath from "path";
const require = createRequire(import.meta.url);

const SHUTDOWN_TIMEOUT = 5 * 60 * 1000;

declare namespace vsda {
	// the signer is a native module that for historical reasons uses a lower case class name
	// eslint-disable-next-line @typescript-eslint/naming-convention
	export class signer {
		sign(arg: string): string;
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	export class validator {
		createNewMessage(arg: string): string;
		validate(arg: string): "ok" | "error";
	}
}

class RemoteExtensionHostAgentServer extends Disposable implements IServerAPI {
	private readonly _extHostConnections: {
		[reconnectionToken: string]: ExtensionHostConnection;
	};
	private readonly _managementConnections: {
		[reconnectionToken: string]: ManagementConnection;
	};
	private readonly _allReconnectionTokens: Set<string>;
	private readonly _webClientServer: WebClientServer | null;
	private readonly _webEndpointOriginChecker: WebEndpointOriginChecker;
	private readonly _reconnectionGraceTime: number;

	private readonly _serverBasePath: string | undefined;
	private readonly _serverProductPath: string;

	private shutdownTimer: Timeout | undefined;

	constructor(
		private readonly _socketServer: SocketServer<RemoteAgentConnectionContext>,
		private readonly _connectionToken: ServerConnectionToken,
		private readonly _vsdaMod: typeof vsda | null,
		hasWebClient: boolean,
		serverBasePath: string | undefined,
		@IServerEnvironmentService
		private readonly _environmentService: IServerEnvironmentService,
		@IProductService private readonly _productService: IProductService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService
		private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._webEndpointOriginChecker = WebEndpointOriginChecker.create(
			this._productService,
		);

		if (
			serverBasePath !== undefined &&
			serverBasePath.charCodeAt(serverBasePath.length - 1) === CharCode.Slash
		) {
			// Remove trailing slash from base path
			serverBasePath = serverBasePath.substring(0, serverBasePath.length - 1);
		}
		this._serverBasePath = serverBasePath; // undefined or starts with a slash
		this._serverProductPath = `/${getServerProductSegment(_productService)}`; // starts with a slash
		this._extHostConnections = Object.create(null);
		this._managementConnections = Object.create(null);
		this._allReconnectionTokens = new Set<string>();
		this._webClientServer = hasWebClient
			? this._instantiationService.createInstance(
					WebClientServer,
					this._connectionToken,
					serverBasePath ?? "/",
					this._serverProductPath,
				)
			: null;
		this._logService.info(`Extension host agent started.`);
		this._reconnectionGraceTime =
			this._environmentService.reconnectionGraceTime;

		this._waitThenShutdown(true);
	}

	public async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		if (!req.url) {
			return serveError(req, res, 400, `Bad request.`);
		}

		const parsedUrl = url.parse(req.url, true);
		let pathname = parsedUrl.pathname;

		if (!pathname) {
			return serveError(req, res, 400, `Bad request.`);
		}

		// Serve from both '/' and serverBasePath
		if (
			this._serverBasePath !== undefined &&
			pathname.startsWith(this._serverBasePath)
		) {
			pathname = pathname.substring(this._serverBasePath.length) || "/";
		}
		// for now accept all paths, with or without server product path
		if (
			pathname.startsWith(this._serverProductPath) &&
			pathname.charCodeAt(this._serverProductPath.length) === CharCode.Slash
		) {
			pathname = pathname.substring(this._serverProductPath.length);
		}

		// Version (no auth needed)
		if (pathname === "/version" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			return void res.end(this._productService.commit || "");
		}

		// Delay shutdown (no auth needed)
		if (pathname === "/delay-shutdown" && req.method === "GET") {
			this._delayShutdown();
			res.writeHead(200);
			return void res.end("OK");
		}

		const nourlmsApiUrl =
			this._environmentService.args["nourlms-api-url"] ||
			process.env.NOURLMS_API_URL ||
			"";

		if (!nourlmsApiUrl) {
			this._logService.warn(
				"[NourLMS] NOURLMS_API_URL is not set. Configure it in .env or via --nourlms-api-url.",
			);
		}

		// GET /nourlms-login-logo.png — must run before session check (browser loads img without cookie)
		if (pathname === "/nourlms-login-logo.png" && req.method === "GET") {
			return this._serveLoginLogo(req, res);
		}

		// GET /nourlms-login - serve login page (no auth needed)
		if (pathname === "/nourlms-login" && req.method === "GET") {
			return this._serveLoginPage(req, res);
		}

		// POST /nourlms-login - proxy login to NourLMS API (no auth needed)
		if (pathname === "/nourlms-login" && req.method === "POST") {
			return this._handleNourlmsLogin(req, res, nourlmsApiUrl);
		}

		// POST /nourlms-logout - clear session and redirect to login (no auth needed, always clears cookie)
		if (pathname === "/nourlms-logout" && req.method === "POST") {
			return this._handleNourlmsLogout(req, res, nourlmsApiUrl);
		}

		// Authentication: always check session cookie (NourLMS auth is mandatory)
		const nourlmsSession = nourlmsAuth.parseSessionCookie(
			req.headers.cookie,
			this._environmentService.userDataPath,
		);
		if (!nourlmsSession) {
			const basePath = this._getBasePath(req);
			res.writeHead(302, { Location: `${basePath}nourlms-login` });
			return void res.end();
		}
		(req as any).__nourlmsSession = nourlmsSession;

		// /nourlms-api/* proxy (after session check, before the GET-only gate)
		if (pathname.startsWith("/nourlms-api/")) {
			const proxyPath = pathname.substring("/nourlms-api".length);
			const query = parsedUrl.search || '';
			return handleNourlmsApiProxy(req, res, proxyPath, query, nourlmsApiUrl, nourlmsSession, this._logService);
		}

		// /nourlms-ai/* admin-only AI proxy (after session check)
		if (pathname.startsWith("/nourlms-ai/")) {
			const aiPath = pathname.substring("/nourlms-ai".length);
			return handleNourlmsAiProxy(req, res, aiPath, nourlmsSession, this._logService);
		}

		// GET /nourlms-workspaces - list student workspaces (admin only, auth required)
		if (pathname === "/nourlms-workspaces" && req.method === "GET") {
			return this._handleNourlmsWorkspaces(req, res, nourlmsSession);
		}

		// GET /nourlms-workspaces/lookup - resolve workspace to userId (admin only, auth required)
		if (pathname === "/nourlms-workspaces/lookup" && req.method === "GET") {
			return this._handleNourlmsWorkspacesLookup(req, res, nourlmsSession, parsedUrl);
		}

		// Only GET for remaining routes
		if (req.method !== "GET") {
			return serveError(req, res, 405, `Unsupported method ${req.method}`);
		}

		if (pathname === "/vscode-remote-resource") {
			// Handle HTTP requests for resources rendered in the rich client (images, fonts, etc.)
			// These resources could be files shipped with extensions or even workspace files.
			const desiredPath = parsedUrl.query["path"];
			if (typeof desiredPath !== "string") {
				return serveError(req, res, 400, `Bad request.`);
			}

			let filePath: string;
			try {
				filePath = URI.from({ scheme: Schemas.file, path: desiredPath }).fsPath;
			} catch (err) {
				return serveError(req, res, 400, `Bad request.`);
			}

			// NourLMS student workspace isolation
			const nourlmsSessionForPath = (req as any).__nourlmsSession as
				| nourlmsAuth.NourlmsSession
				| undefined;
			if (nourlmsSessionForPath && nourlmsSessionForPath.role === "student") {
				const workspacesDir =
					this._environmentService.args["nourlms-workspaces-dir"] ||
					process.env.NOURLMS_WORKSPACES_DIR ||
					nodePath.join(os.homedir(), "nourlms-workspaces");
				const sanitizedName = nourlmsAuth.sanitizeUsername(
					nourlmsSessionForPath.name,
				);
				const allowedPath = nodePath.resolve(
					nodePath.join(workspacesDir, sanitizedName),
				);
				const requestedResolved = nodePath.resolve(filePath);
				const resolvedWorkspacesDir = nodePath.resolve(workspacesDir);
				const isInsideWorkspacesDir =
					requestedResolved.startsWith(resolvedWorkspacesDir + nodePath.sep) ||
					requestedResolved === resolvedWorkspacesDir;
				if (isInsideWorkspacesDir) {
					if (
						!requestedResolved.startsWith(allowedPath + nodePath.sep) &&
						requestedResolved !== allowedPath
					) {
						return serveError(req, res, 403, `Access denied.`);
					}
				}
			}

			const responseHeaders: Record<string, string> = Object.create(null);
			if (this._environmentService.isBuilt) {
				if (
					isEqualOrParent(
						filePath,
						this._environmentService.builtinExtensionsPath,
						!platform.isLinux,
					) ||
					isEqualOrParent(
						filePath,
						this._environmentService.extensionsPath,
						!platform.isLinux,
					)
				) {
					responseHeaders["Cache-Control"] = "public, max-age=31536000";
				}
			}

			// Allow cross origin requests from the web worker extension host
			responseHeaders["Vary"] = "Origin";
			const requestOrigin = req.headers["origin"];
			if (
				requestOrigin &&
				this._webEndpointOriginChecker.matches(requestOrigin)
			) {
				responseHeaders["Access-Control-Allow-Origin"] = requestOrigin;
			}
			return serveFile(
				filePath,
				CacheControl.ETAG,
				this._logService,
				req,
				res,
				responseHeaders,
			);
		}

		// workbench web UI
		if (this._webClientServer) {
			this._webClientServer.handle(req, res, parsedUrl, pathname);
			return;
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		return void res.end("Not found");
	}

	private _getBasePath(req: http.IncomingMessage): string {
		const forwardedPrefix = req.headers["x-forwarded-prefix"];
		const val = Array.isArray(forwardedPrefix)
			? forwardedPrefix[0]
			: forwardedPrefix;
		if (typeof val === "string" && val.length > 0) {
			return val.endsWith("/") ? val : val + "/";
		}
		return "/";
	}

	private async _serveLoginPage(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		try {
			const loginPagePath = FileAccess.asFileUri(
				"vs/server/nourlms-login.html",
			).fsPath;
			const html = (await fs.promises.readFile(loginPagePath)).toString("utf8");
			res.writeHead(200, {
				"Content-Type": "text/html",
				"Cache-Control": "no-store",
			});
			return void res.end(html);
		} catch (e) {
			this._logService.error("Failed to serve login page", e);
			return serveError(_req, res, 500, "Failed to serve login page.");
		}
	}

	private async _serveLoginLogo(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		try {
			const logoPath = FileAccess.asFileUri(
				"vs/server/nourlms-login-logo.png",
			).fsPath;
			const buf = await fs.promises.readFile(logoPath);
			res.writeHead(200, {
				"Content-Type": "image/png",
				"Cache-Control": "public, max-age=86400",
			});
			return void res.end(buf);
		} catch (e) {
			this._logService.trace("Login logo PNG not available, skipping asset.");
			return serveError(_req, res, 404, "Not found.");
		}
	}

	private async _handleNourlmsLogin(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		nourlmsApiUrl: string | undefined,
	): Promise<void> {
		if (!nourlmsApiUrl) {
			return serveError(req, res, 500, "NourLMS API URL not configured.");
		}

		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			let phone: string | undefined;
			let password: string | undefined;
			try {
				const parsed = JSON.parse(body);
				phone = parsed.phone;
				password = parsed.password;
			} catch {
				try {
					const params = new URLSearchParams(body);
					phone = params.get("phone") || undefined;
					password = params.get("password") || undefined;
				} catch {
					// fallback
				}
			}

			if (!phone || !password) {
				const basePath = this._getBasePath(req);
				res.writeHead(302, {
					Location: `${basePath}nourlms-login?error=${encodeURIComponent("Phone number and password are required.")}`,
				});
				return void res.end();
			}

			const loginUrl = `${nourlmsApiUrl.replace(/\/+$/, "")}/auth/login`;
			const postData = JSON.stringify({ phone, password });
			const apiUrl = url.parse(loginUrl);

			const options: nodeHttp.RequestOptions = {
				hostname: apiUrl.hostname,
				port: apiUrl.port || (apiUrl.protocol === "https:" ? 443 : 80),
				path: apiUrl.path,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"Content-Length": Buffer.byteLength(postData),
				},
			};

			const httpModule =
				apiUrl.protocol === "https:" ? require("https") : require("http");
			const apiReq = httpModule.request(
				options,
				(apiRes: nodeHttp.IncomingMessage) => {
					let data = "";
					apiRes.on("data", (chunk: Buffer) => {
						data += chunk.toString();
					});
					apiRes.on("end", () => {
						const basePath = this._getBasePath(req);

						if (apiRes.statusCode === 200) {
							try {
								const result = JSON.parse(data);
								const session: nourlmsAuth.NourlmsSession = {
									userId: result.user.id,
									name: result.user.name,
									role: result.user.roles[0] || "student",
									token: result.token,
								};
								const cookieStr = nourlmsAuth.createSessionCookie(
									session,
									this._environmentService.userDataPath,
								);
								res.writeHead(302, {
									Location: basePath,
									"Set-Cookie": cookieStr,
								});
								return void res.end();
							} catch {
								res.writeHead(302, {
									Location: `${basePath}nourlms-login?error=${encodeURIComponent("Login failed. Please try again.")}`,
								});
								return void res.end();
							}
						}

						if (apiRes.statusCode === 403) {
							res.writeHead(302, {
								Location: `${basePath}nourlms-login?error=${encodeURIComponent("Account is suspended.")}`,
							});
							return void res.end();
						}

						if (apiRes.statusCode === 429) {
							res.writeHead(302, {
								Location: `${basePath}nourlms-login?error=${encodeURIComponent("Too many login attempts. Please try again later.")}`,
							});
							return void res.end();
						}

						res.writeHead(302, {
							Location: `${basePath}nourlms-login?error=${encodeURIComponent("Invalid credentials.")}`,
						});
						return void res.end();
					});
				},
			);

			apiReq.on("error", () => {
				const basePath = this._getBasePath(req);
				res.writeHead(302, {
					Location: `${basePath}nourlms-login?error=${encodeURIComponent("Unable to connect to authentication server.")}`,
				});
				return void res.end();
			});

			apiReq.write(postData);
			apiReq.end();
		});
	}

	private async _handleNourlmsLogout(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		nourlmsApiUrl: string | undefined,
	): Promise<void> {
		const session = nourlmsAuth.parseSessionCookie(
			req.headers.cookie,
			this._environmentService.userDataPath,
		);
		const basePath = this._getBasePath(req);

		if (session && nourlmsApiUrl) {
			const logoutUrl = `${nourlmsApiUrl.replace(/\/+$/, "")}/auth/logout`;
			const apiUrl = url.parse(logoutUrl);
			const options: nodeHttp.RequestOptions = {
				hostname: apiUrl.hostname,
				port: apiUrl.port || (apiUrl.protocol === "https:" ? 443 : 80),
				path: apiUrl.path,
				method: "POST",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${session.token}`,
				},
			};
			const httpModule =
				apiUrl.protocol === "https:" ? require("https") : require("http");
			try {
				const apiReq = httpModule.request(
					options,
					(apiRes: nodeHttp.IncomingMessage) => {
						apiRes.resume();
					},
				);
				apiReq.on("error", () => {});
				apiReq.end();
			} catch {}
		}

		res.writeHead(302, {
			Location: `${basePath}nourlms-login`,
			"Set-Cookie": nourlmsAuth.createLogoutCookie(),
		});
		return void res.end();
	}

	private _handleNourlmsWorkspaces(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		session: nourlmsAuth.NourlmsSession,
	): void {
		if (session.role !== "admin") {
			res.writeHead(403, { "Content-Type": "application/json" });
			return void res.end(JSON.stringify({ error: "Access denied." }));
		}

		const workspacesDir =
			this._environmentService.args["nourlms-workspaces-dir"] ||
			process.env.NOURLMS_WORKSPACES_DIR ||
			nodePath.join(os.homedir(), "nourlms-workspaces");
		try {
			if (!fs.existsSync(workspacesDir)) {
				res.writeHead(200, { "Content-Type": "application/json" });
				return void res.end(JSON.stringify({ workspaces: [] }));
			}
			const entries = fs.readdirSync(workspacesDir, { withFileTypes: true });
			const workspaces = entries
				.filter((e) => e.isDirectory())
				.map((e) => {
					const wsPath = nodePath.join(workspacesDir, e.name);
					const sidecar = nourlmsAuth.readWorkspaceSidecar(wsPath);
					const entry: { name: string; path: string; userId?: number; displayName?: string } = {
						name: e.name,
						path: wsPath,
					};
					if (sidecar) {
						entry.userId = sidecar.userId;
						entry.displayName = sidecar.name;
					}
					return entry;
				});
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			});
			return void res.end(JSON.stringify({ workspaces }));
		} catch (e) {
			this._logService.error("Failed to list workspaces", e);
			res.writeHead(500, { "Content-Type": "application/json" });
			return void res.end(
				JSON.stringify({ error: "Failed to list workspaces." }),
			);
		}
	}

	private _handleNourlmsWorkspacesLookup(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		session: nourlmsAuth.NourlmsSession,
		parsedUrl: url.UrlWithParsedQuery,
	): void {
		if (session.role !== "admin") {
			res.writeHead(403, { "Content-Type": "application/json" });
			return void res.end(JSON.stringify({ error: "Access denied." }));
		}

		const rawPath = parsedUrl.query["path"];
		if (typeof rawPath !== "string" || !rawPath) {
			res.writeHead(400, { "Content-Type": "application/json" });
			return void res.end(JSON.stringify({ error: "Missing path parameter." }));
		}

		const workspacesDir =
			this._environmentService.args["nourlms-workspaces-dir"] ||
			process.env.NOURLMS_WORKSPACES_DIR ||
			nodePath.join(os.homedir(), "nourlms-workspaces");
		const wsDirAbs = nodePath.resolve(workspacesDir);

		let candidate: string;
		if (nodePath.isAbsolute(rawPath)) {
			candidate = nodePath.resolve(rawPath);
		} else {
			candidate = nodePath.resolve(wsDirAbs, nodePath.basename(rawPath));
		}

		if (!candidate.startsWith(wsDirAbs + nodePath.sep) && candidate !== wsDirAbs) {
			res.writeHead(404, { "Content-Type": "application/json" });
			return void res.end(JSON.stringify({ error: "Workspace not recognized" }));
		}

		const sidecar = nourlmsAuth.readWorkspaceSidecar(candidate);
		if (!sidecar) {
			res.writeHead(404, { "Content-Type": "application/json" });
			return void res.end(JSON.stringify({ error: "Workspace not recognized" }));
		}

		res.writeHead(200, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		});
		return void res.end(JSON.stringify({
			userId: sidecar.userId,
			name: sidecar.name,
			sanitizedName: sidecar.sanitizedName,
			path: candidate,
		}));
	}

	public handleUpgrade(req: http.IncomingMessage, socket: net.Socket) {
		let reconnectionToken = generateUuid();
		let isReconnection = false;
		let skipWebSocketFrames = false;

		if (req.url) {
			const query = url.parse(req.url, true).query;
			if (typeof query.reconnectionToken === "string") {
				reconnectionToken = query.reconnectionToken;
			}
			if (query.reconnection === "true") {
				isReconnection = true;
			}
			if (query.skipWebSocketFrames === "true") {
				skipWebSocketFrames = true;
			}
		}

		const upgraded = upgradeToISocket(req, socket, {
			debugLabel: `server-connection-${reconnectionToken}`,
			skipWebSocketFrames,
			disableWebSocketCompression:
				this._environmentService.args["disable-websocket-compression"],
		});

		if (!upgraded) {
			return;
		}

		this._handleWebSocketConnection(
			upgraded,
			isReconnection,
			reconnectionToken,
		);
	}

	public handleServerError(err: Error): void {
		this._logService.error(`Error occurred in server`);
		this._logService.error(err);
	}

	// Eventually cleanup

	private _getRemoteAddress(socket: NodeSocket | WebSocketNodeSocket): string {
		let _socket: net.Socket;
		if (socket instanceof NodeSocket) {
			_socket = socket.socket;
		} else {
			_socket = socket.socket.socket;
		}
		return _socket.remoteAddress || `<unknown>`;
	}

	private async _rejectWebSocketConnection(
		logPrefix: string,
		protocol: PersistentProtocol,
		reason: string,
	): Promise<void> {
		const socket = protocol.getSocket();
		this._logService.error(`${logPrefix} ${reason}.`);
		const errMessage: ErrorMessage = {
			type: "error",
			reason: reason,
		};
		protocol.sendControl(VSBuffer.fromString(JSON.stringify(errMessage)));
		protocol.dispose();
		await socket.drain();
		socket.dispose();
	}

	/**
	 * NOTE: Avoid using await in this method!
	 * The problem is that await introduces a process.nextTick due to the implicit Promise.then
	 * This can lead to some bytes being received and interpreted and a control message being emitted before the next listener has a chance to be registered.
	 */
	private _handleWebSocketConnection(
		socket: NodeSocket | WebSocketNodeSocket,
		isReconnection: boolean,
		reconnectionToken: string,
	): void {
		const remoteAddress = this._getRemoteAddress(socket);
		const logPrefix = `[${remoteAddress}][${reconnectionToken.substr(0, 8)}]`;
		const protocol = new PersistentProtocol({ socket });

		const validator = this._vsdaMod ? new this._vsdaMod.validator() : null;
		const signer = this._vsdaMod ? new this._vsdaMod.signer() : null;

		const enum State {
			WaitingForAuth,
			WaitingForConnectionType,
			Done,
			Error,
		}
		let state = State.WaitingForAuth;

		const rejectWebSocketConnection = (msg: string) => {
			state = State.Error;
			listener.dispose();
			this._rejectWebSocketConnection(logPrefix, protocol, msg);
		};

		const listener = protocol.onControlMessage((raw) => {
			if (state === State.WaitingForAuth) {
				let msg1: HandshakeMessage;
				try {
					msg1 = <HandshakeMessage>JSON.parse(raw.toString());
				} catch (err) {
					return rejectWebSocketConnection(`Malformed first message`);
				}
				if (msg1.type !== "auth") {
					return rejectWebSocketConnection(`Invalid first message`);
				}

				if (
					this._connectionToken.type === ServerConnectionTokenType.Mandatory &&
					!this._connectionToken.validate(msg1.auth)
				) {
					return rejectWebSocketConnection(
						`Unauthorized client refused: auth mismatch`,
					);
				}

				// Send `sign` request
				let signedData = generateUuid();
				if (signer) {
					try {
						signedData = signer.sign(msg1.data);
					} catch (e) {}
				}
				let someText = generateUuid();
				if (validator) {
					try {
						someText = validator.createNewMessage(someText);
					} catch (e) {}
				}
				const signRequest: SignRequest = {
					type: "sign",
					data: someText,
					signedData: signedData,
				};
				protocol.sendControl(VSBuffer.fromString(JSON.stringify(signRequest)));

				state = State.WaitingForConnectionType;
			} else if (state === State.WaitingForConnectionType) {
				let msg2: HandshakeMessage;
				try {
					msg2 = <HandshakeMessage>JSON.parse(raw.toString());
				} catch (err) {
					return rejectWebSocketConnection(`Malformed second message`);
				}
				if (msg2.type !== "connectionType") {
					return rejectWebSocketConnection(`Invalid second message`);
				}
				if (typeof msg2.signedData !== "string") {
					return rejectWebSocketConnection(`Invalid second message field type`);
				}

				const rendererCommit = msg2.commit;
				const myCommit = this._productService.commit;
				if (rendererCommit && myCommit) {
					// Running in the built version where commits are defined
					if (rendererCommit !== myCommit) {
						return rejectWebSocketConnection(
							`Client refused: version mismatch`,
						);
					}
				}

				let valid = false;
				if (!validator) {
					valid = true;
				} else if (this._connectionToken.validate(msg2.signedData)) {
					// web client
					valid = true;
				} else {
					try {
						valid = validator.validate(msg2.signedData) === "ok";
					} catch (e) {}
				}

				if (!valid) {
					if (this._environmentService.isBuilt) {
						return rejectWebSocketConnection(`Unauthorized client refused`);
					} else {
						this._logService.error(
							`${logPrefix} Unauthorized client handshake failed but we proceed because of dev mode.`,
						);
					}
				}

				// We have received a new connection.
				// This indicates that the server owner has connectivity.
				// Therefore we will shorten the reconnection grace period for disconnected connections!
				for (const key in this._managementConnections) {
					const managementConnection = this._managementConnections[key];
					managementConnection.shortenReconnectionGraceTimeIfNecessary();
				}
				for (const key in this._extHostConnections) {
					const extHostConnection = this._extHostConnections[key];
					extHostConnection.shortenReconnectionGraceTimeIfNecessary();
				}

				state = State.Done;
				listener.dispose();
				this._handleConnectionType(
					remoteAddress,
					logPrefix,
					protocol,
					socket,
					isReconnection,
					reconnectionToken,
					msg2,
				);
			}
		});
	}

	private async _handleConnectionType(
		remoteAddress: string,
		_logPrefix: string,
		protocol: PersistentProtocol,
		socket: NodeSocket | WebSocketNodeSocket,
		isReconnection: boolean,
		reconnectionToken: string,
		msg: ConnectionTypeRequest,
	): Promise<void> {
		const logPrefix =
			msg.desiredConnectionType === ConnectionType.Management
				? `${_logPrefix}[ManagementConnection]`
				: msg.desiredConnectionType === ConnectionType.ExtensionHost
					? `${_logPrefix}[ExtensionHostConnection]`
					: _logPrefix;

		if (msg.desiredConnectionType === ConnectionType.Management) {
			// This should become a management connection
			if (socket instanceof WebSocketNodeSocket) {
				socket.setRecordInflateBytes(false);
			}

			if (isReconnection) {
				// This is a reconnection
				if (!this._managementConnections[reconnectionToken]) {
					if (!this._allReconnectionTokens.has(reconnectionToken)) {
						// This is an unknown reconnection token
						return this._rejectWebSocketConnection(
							logPrefix,
							protocol,
							`Unknown reconnection token (never seen)`,
						);
					} else {
						// This is a connection that was seen in the past, but is no longer valid
						return this._rejectWebSocketConnection(
							logPrefix,
							protocol,
							`Unknown reconnection token (seen before)`,
						);
					}
				}

				protocol.sendControl(
					VSBuffer.fromString(JSON.stringify({ type: "ok" })),
				);
				const dataChunk = protocol.readEntireBuffer();
				protocol.dispose();
				this._managementConnections[reconnectionToken].acceptReconnection(
					remoteAddress,
					socket,
					dataChunk,
				);
			} else {
				// This is a fresh connection
				if (this._managementConnections[reconnectionToken]) {
					// Cannot have two concurrent connections using the same reconnection token
					return this._rejectWebSocketConnection(
						logPrefix,
						protocol,
						`Duplicate reconnection token`,
					);
				}

				protocol.sendControl(
					VSBuffer.fromString(JSON.stringify({ type: "ok" })),
				);
				const con = new ManagementConnection(
					this._logService,
					reconnectionToken,
					remoteAddress,
					protocol,
					this._reconnectionGraceTime,
				);
				this._socketServer.acceptConnection(con.protocol, con.onClose);
				this._managementConnections[reconnectionToken] = con;
				this._allReconnectionTokens.add(reconnectionToken);
				con.onClose(() => {
					delete this._managementConnections[reconnectionToken];
				});
			}
		} else if (msg.desiredConnectionType === ConnectionType.ExtensionHost) {
			// This should become an extension host connection
			const startParams0 = <IRemoteExtensionHostStartParams>msg.args || {
				language: "en",
			};
			const startParams = await this._updateWithFreeDebugPort(startParams0);

			if (startParams.port) {
				this._logService.trace(
					`${logPrefix} - startParams debug port ${startParams.port}`,
				);
			}
			this._logService.trace(
				`${logPrefix} - startParams language: ${startParams.language}`,
			);
			this._logService.trace(
				`${logPrefix} - startParams env: ${JSON.stringify(startParams.env)}`,
			);

			if (isReconnection) {
				// This is a reconnection
				if (!this._extHostConnections[reconnectionToken]) {
					if (!this._allReconnectionTokens.has(reconnectionToken)) {
						// This is an unknown reconnection token
						return this._rejectWebSocketConnection(
							logPrefix,
							protocol,
							`Unknown reconnection token (never seen)`,
						);
					} else {
						// This is a connection that was seen in the past, but is no longer valid
						return this._rejectWebSocketConnection(
							logPrefix,
							protocol,
							`Unknown reconnection token (seen before)`,
						);
					}
				}

				protocol.sendPause();
				protocol.sendControl(
					VSBuffer.fromString(
						JSON.stringify(
							startParams.port ? { debugPort: startParams.port } : {},
						),
					),
				);
				const dataChunk = protocol.readEntireBuffer();
				protocol.dispose();
				this._extHostConnections[reconnectionToken].acceptReconnection(
					remoteAddress,
					socket,
					dataChunk,
				);
			} else {
				// This is a fresh connection
				if (this._extHostConnections[reconnectionToken]) {
					// Cannot have two concurrent connections using the same reconnection token
					return this._rejectWebSocketConnection(
						logPrefix,
						protocol,
						`Duplicate reconnection token`,
					);
				}

				protocol.sendPause();
				protocol.sendControl(
					VSBuffer.fromString(
						JSON.stringify(
							startParams.port ? { debugPort: startParams.port } : {},
						),
					),
				);
				const dataChunk = protocol.readEntireBuffer();
				protocol.dispose();
				const con = this._instantiationService.createInstance(
					ExtensionHostConnection,
					reconnectionToken,
					remoteAddress,
					socket,
					dataChunk,
				);
				this._extHostConnections[reconnectionToken] = con;
				this._allReconnectionTokens.add(reconnectionToken);
				con.onClose(() => {
					con.dispose();
					delete this._extHostConnections[reconnectionToken];
					this._onDidCloseExtHostConnection();
				});
				con.start(startParams);
			}
		} else if (msg.desiredConnectionType === ConnectionType.Tunnel) {
			if (socket instanceof WebSocketNodeSocket) {
				socket.setRecordInflateBytes(false);
			}

			const tunnelStartParams = <ITunnelConnectionStartParams>msg.args;
			this._createTunnel(protocol, tunnelStartParams);
		} else {
			return this._rejectWebSocketConnection(
				logPrefix,
				protocol,
				`Unknown initial data received`,
			);
		}
	}

	private async _createTunnel(
		protocol: PersistentProtocol,
		tunnelStartParams: ITunnelConnectionStartParams,
	): Promise<void> {
		const remoteSocket = (<NodeSocket>protocol.getSocket()).socket;
		const dataChunk = protocol.readEntireBuffer();
		protocol.dispose();

		remoteSocket.pause();
		const localSocket = await this._connectTunnelSocket(
			tunnelStartParams.host,
			tunnelStartParams.port,
		);

		if (dataChunk.byteLength > 0) {
			localSocket.write(dataChunk.buffer);
		}

		localSocket.on("end", () => remoteSocket.end());
		localSocket.on("close", () => remoteSocket.end());
		localSocket.on("error", () => remoteSocket.destroy());
		remoteSocket.on("end", () => localSocket.end());
		remoteSocket.on("close", () => localSocket.end());
		remoteSocket.on("error", () => localSocket.destroy());

		localSocket.pipe(remoteSocket);
		remoteSocket.pipe(localSocket);
	}

	private _connectTunnelSocket(
		host: string,
		port: number,
	): Promise<net.Socket> {
		return new Promise<net.Socket>((c, e) => {
			const socket = net.createConnection(
				{
					host: host,
					port: port,
					autoSelectFamily: true,
				},
				() => {
					socket.removeListener("error", e);
					socket.pause();
					c(socket);
				},
			);

			socket.once("error", e);
		});
	}

	private _updateWithFreeDebugPort(
		startParams: IRemoteExtensionHostStartParams,
	): Thenable<IRemoteExtensionHostStartParams> {
		if (typeof startParams.port === "number") {
			return findFreePort(
				startParams.port,
				10 /* try 10 ports */,
				5000 /* try up to 5 seconds */,
			).then((freePort) => {
				startParams.port = freePort;
				return startParams;
			});
		}
		// No port clear debug configuration.
		startParams.debugId = undefined;
		startParams.port = undefined;
		startParams.break = undefined;
		return Promise.resolve(startParams);
	}

	private async _onDidCloseExtHostConnection(): Promise<void> {
		if (!this._environmentService.args["enable-remote-auto-shutdown"]) {
			return;
		}

		this._cancelShutdown();

		const hasActiveExtHosts = !!Object.keys(this._extHostConnections).length;
		if (!hasActiveExtHosts) {
			console.log("Last EH closed, waiting before shutting down");
			this._logService.info("Last EH closed, waiting before shutting down");
			this._waitThenShutdown();
		}
	}

	private _waitThenShutdown(initial = false): void {
		if (!this._environmentService.args["enable-remote-auto-shutdown"]) {
			return;
		}

		if (
			this._environmentService.args["remote-auto-shutdown-without-delay"] &&
			!initial
		) {
			this._shutdown();
		} else {
			this.shutdownTimer = setTimeout(() => {
				this.shutdownTimer = undefined;

				this._shutdown();
			}, SHUTDOWN_TIMEOUT);
		}
	}

	private _shutdown(): void {
		const hasActiveExtHosts = !!Object.keys(this._extHostConnections).length;
		if (hasActiveExtHosts) {
			console.log("New EH opened, aborting shutdown");
			this._logService.info("New EH opened, aborting shutdown");
			return;
		} else {
			console.log("Last EH closed, shutting down");
			this._logService.info("Last EH closed, shutting down");
			this.dispose();
			process.exit(0);
		}
	}

	/**
	 * If the server is in a shutdown timeout, cancel it and start over
	 */
	private _delayShutdown(): void {
		if (this.shutdownTimer) {
			console.log(
				"Got delay-shutdown request while in shutdown timeout, delaying",
			);
			this._logService.info(
				"Got delay-shutdown request while in shutdown timeout, delaying",
			);
			this._cancelShutdown();
			this._waitThenShutdown();
		}
	}

	private _cancelShutdown(): void {
		if (this.shutdownTimer) {
			console.log("Cancelling previous shutdown timeout");
			this._logService.info("Cancelling previous shutdown timeout");
			clearTimeout(this.shutdownTimer);
			this.shutdownTimer = undefined;
		}
	}
}

export interface IServerAPI {
	/**
	 * Do not remove!!. Called from server-main.js
	 */
	handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void>;
	/**
	 * Do not remove!!. Called from server-main.js
	 */
	handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void;
	/**
	 * Do not remove!!. Called from server-main.js
	 */
	handleServerError(err: Error): void;
	/**
	 * Do not remove!!. Called from server-main.js
	 */
	dispose(): void;
}

export async function createServer(
	address: string | net.AddressInfo | null,
	args: ServerParsedArgs,
	REMOTE_DATA_FOLDER: string,
): Promise<IServerAPI> {
	const connectionToken = await determineServerConnectionToken(args);
	if (connectionToken instanceof ServerConnectionTokenParseError) {
		console.warn(connectionToken.message);
		process.exit(1);
	}

	// setting up error handlers, first with console.error, then, once available, using the log service

	function initUnexpectedErrorHandler(handler: (err: any) => void) {
		setUnexpectedErrorHandler((err) => {
			// See https://github.com/microsoft/vscode-remote-release/issues/6481
			// In some circumstances, console.error will throw an asynchronous error. This asynchronous error
			// will end up here, and then it will be logged again, thus creating an endless asynchronous loop.
			// Here we try to break the loop by ignoring EPIPE errors that include our own unexpected error handler in the stack.
			if (
				isSigPipeError(err) &&
				err.stack &&
				/unexpectedErrorHandler/.test(err.stack)
			) {
				return;
			}
			handler(err);
		});
	}

	const unloggedErrors: any[] = [];
	initUnexpectedErrorHandler((error: any) => {
		unloggedErrors.push(error);
		console.error(error);
	});
	let didLogAboutSIGPIPE = false;
	process.on("SIGPIPE", () => {
		// See https://github.com/microsoft/vscode-remote-release/issues/6543
		// We would normally install a SIGPIPE listener in bootstrap-node.js
		// But in certain situations, the console itself can be in a broken pipe state
		// so logging SIGPIPE to the console will cause an infinite async loop
		if (!didLogAboutSIGPIPE) {
			didLogAboutSIGPIPE = true;
			onUnexpectedError(new Error(`Unexpected SIGPIPE`));
		}
	});

	const disposables = new DisposableStore();
	const { socketServer, instantiationService } = await setupServerServices(
		connectionToken,
		args,
		REMOTE_DATA_FOLDER,
		disposables,
	);

	// Set the unexpected error handler after the services have been initialized, to avoid having
	// the telemetry service overwrite our handler
	instantiationService.invokeFunction((accessor) => {
		const logService = accessor.get(ILogService);
		unloggedErrors.forEach((error) => logService.error(error));
		unloggedErrors.length = 0;

		initUnexpectedErrorHandler((error: any) => logService.error(error));
	});

	// On Windows, configure the UNC allow list based on settings
	instantiationService.invokeFunction((accessor) => {
		const configurationService = accessor.get(IConfigurationService);

		if (platform.isWindows) {
			if (
				configurationService.getValue("security.restrictUNCAccess") === false
			) {
				disableUNCAccessRestrictions();
			} else {
				addUNCHostToAllowlist(
					configurationService.getValue("security.allowedUNCHosts"),
				);
			}
		}
	});

	//
	// On Windows, exit early with warning message to users about potential security issue
	// if there is node_modules folder under home drive or Users folder.
	//
	instantiationService.invokeFunction((accessor) => {
		const logService = accessor.get(ILogService);

		if (platform.isWindows && process.env.HOMEDRIVE && process.env.HOMEPATH) {
			const homeDirModulesPath = join(process.env.HOMEDRIVE, "node_modules");
			const userDir = dirname(
				join(process.env.HOMEDRIVE, process.env.HOMEPATH),
			);
			const userDirModulesPath = join(userDir, "node_modules");
			if (
				fs.existsSync(homeDirModulesPath) ||
				fs.existsSync(userDirModulesPath)
			) {
				const message = `

*
* !!!! Server terminated due to presence of CVE-2020-1416 !!!!
*
* Please remove the following directories and re-try
* ${homeDirModulesPath}
* ${userDirModulesPath}
*
* For more information on the vulnerability https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2020-1416
*

`;
				logService.warn(message);
				console.warn(message);
				process.exit(0);
			}
		}
	});

	const vsdaMod = instantiationService.invokeFunction((accessor) => {
		const logService = accessor.get(ILogService);
		const hasVSDA = fs.existsSync(
			join(FileAccess.asFileUri("").fsPath, "../node_modules/vsda"),
		);
		if (hasVSDA) {
			try {
				return require("vsda");
			} catch (err) {
				logService.error(err);
			}
		}
		return null;
	});

	let serverBasePath = args["server-base-path"];
	if (serverBasePath && !serverBasePath.startsWith("/")) {
		serverBasePath = `/${serverBasePath}`;
	}

	const hasWebClient = fs.existsSync(
		FileAccess.asFileUri(`vs/code/browser/workbench/workbench.html`).fsPath,
	);

	if (hasWebClient && address && typeof address !== "string") {
		// ships the web ui!
		const queryPart =
			connectionToken.type !== ServerConnectionTokenType.None
				? `?${connectionTokenQueryName}=${connectionToken.value}`
				: "";
		console.log(
			`Web UI available at http://localhost${address.port === 80 ? "" : `:${address.port}`}${serverBasePath ?? ""}${queryPart}`,
		);
	}

	const remoteExtensionHostAgentServer = instantiationService.createInstance(
		RemoteExtensionHostAgentServer,
		socketServer,
		connectionToken,
		vsdaMod,
		hasWebClient,
		serverBasePath,
	);

	perf.mark("code/server/ready");
	const currentTime = performance.now();
	// eslint-disable-next-line local/code-no-any-casts
	const vscodeServerStartTime: number = (<any>global).vscodeServerStartTime;
	// eslint-disable-next-line local/code-no-any-casts
	const vscodeServerListenTime: number = (<any>global).vscodeServerListenTime;
	// eslint-disable-next-line local/code-no-any-casts
	const vscodeServerCodeLoadedTime: number = (<any>global)
		.vscodeServerCodeLoadedTime;

	instantiationService.invokeFunction(async (accessor) => {
		const telemetryService = accessor.get(ITelemetryService);

		type ServerStartClassification = {
			owner: "alexdima";
			comment: "The server has started up";
			startTime: {
				classification: "SystemMetaData";
				purpose: "PerformanceAndHealth";
				comment: "The time the server started at.";
			};
			startedTime: {
				classification: "SystemMetaData";
				purpose: "PerformanceAndHealth";
				comment: "The time the server began listening for connections.";
			};
			codeLoadedTime: {
				classification: "SystemMetaData";
				purpose: "PerformanceAndHealth";
				comment: "The time which the code loaded on the server";
			};
			readyTime: {
				classification: "SystemMetaData";
				purpose: "PerformanceAndHealth";
				comment: "The time when the server was completely ready";
			};
		};
		type ServerStartEvent = {
			startTime: number;
			startedTime: number;
			codeLoadedTime: number;
			readyTime: number;
		};
		telemetryService.publicLog2<ServerStartEvent, ServerStartClassification>(
			"serverStart",
			{
				startTime: vscodeServerStartTime,
				startedTime: vscodeServerListenTime,
				codeLoadedTime: vscodeServerCodeLoadedTime,
				readyTime: currentTime,
			},
		);

		if (platform.isLinux) {
			const logService = accessor.get(ILogService);
			const releaseInfo = await getOSReleaseInfo(
				logService.error.bind(logService),
			);
			if (releaseInfo) {
				type ServerPlatformInfoClassification = {
					platformId: {
						classification: "SystemMetaData";
						purpose: "FeatureInsight";
						comment: "A string identifying the operating system without any version information.";
					};
					platformVersionId: {
						classification: "SystemMetaData";
						purpose: "FeatureInsight";
						comment: "A string identifying the operating system version excluding any name information or release code.";
					};
					platformIdLike: {
						classification: "SystemMetaData";
						purpose: "FeatureInsight";
						comment: "A string identifying the operating system the current OS derivate is closely related to.";
					};
					owner: "deepak1556";
					comment: "Provides insight into the distro information on Linux.";
				};
				type ServerPlatformInfoEvent = {
					platformId: string;
					platformVersionId: string | undefined;
					platformIdLike: string | undefined;
				};
				telemetryService.publicLog2<
					ServerPlatformInfoEvent,
					ServerPlatformInfoClassification
				>("serverPlatformInfo", {
					platformId: releaseInfo.id,
					platformVersionId: releaseInfo.version_id,
					platformIdLike: releaseInfo.id_like,
				});
			}
		}
	});

	if (args["print-startup-performance"]) {
		let output = "";
		output += `Start-up time: ${vscodeServerListenTime - vscodeServerStartTime}\n`;
		output += `Code loading time: ${vscodeServerCodeLoadedTime - vscodeServerStartTime}\n`;
		output += `Initialized time: ${currentTime - vscodeServerStartTime}\n`;
		output += `\n`;
		console.log(output);
	}
	return remoteExtensionHostAgentServer;
}

class WebEndpointOriginChecker {
	public static create(
		productService: IProductService,
	): WebEndpointOriginChecker {
		const webEndpointUrlTemplate = productService.webEndpointUrlTemplate;
		const commit = productService.commit;
		const quality = productService.quality;
		if (!webEndpointUrlTemplate || !commit || !quality) {
			return new WebEndpointOriginChecker(null);
		}

		const uuid = generateUuid();
		const exampleUrl = new URL(
			webEndpointUrlTemplate
				.replace("{{uuid}}", uuid)
				.replace("{{commit}}", commit)
				.replace("{{quality}}", quality),
		);
		const exampleOrigin = exampleUrl.origin;
		const originRegExpSource = escapeRegExpCharacters(exampleOrigin).replace(
			uuid,
			"[a-zA-Z0-9\\-]+",
		);
		try {
			const originRegExp = createRegExp(`^${originRegExpSource}$`, true, {
				matchCase: false,
			});
			return new WebEndpointOriginChecker(originRegExp);
		} catch (err) {
			return new WebEndpointOriginChecker(null);
		}
	}

	constructor(private readonly _originRegExp: RegExp | null) {}

	public matches(origin: string): boolean {
		if (!this._originRegExp) {
			return false;
		}
		return this._originRegExp.test(origin);
	}
}
