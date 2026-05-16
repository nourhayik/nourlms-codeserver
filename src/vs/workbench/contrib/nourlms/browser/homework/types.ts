/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type QuestionType = 'code' | 'text' | 'textarea' | 'rb' | 'cb';

export interface Question {
	id: number;
	content: string;
	course_id: number;
	question_subject_id: number;
	question_type_id: number;
	question_type: QuestionType;
	difficulty_rate_id: number;
	weight: number;
	is_homework: boolean;
	is_auto_correct: boolean;
	time_in_second: number;
	best_answer: string | null;
	pre_answer: string | null;
}

export interface Homework {
	id: number;
	user_id: number;
	question_id: number;
	question: Question;
	student: { id: number; name: string; phone: string };
	is_corrected: boolean;
	mark: number | null;
	correct_the_answer: string | null;
	created_at: string;
}

export interface HomeworkSubmission {
	id: number;
	homework_id: number;
	content: string;
	submitted_at: string;
	is_corrected: boolean;
	latest_ai_result_id: number | null;
}

export interface AiGradingResult {
	id: number;
	grade: number;
	question_type: QuestionType;
	syntax_error: string | null;
	hint_syntax_fix: string | null;
	logical_error: string | null;
	hint_logical_fix: string | null;
	explanation: string;
	best_answer_comparison: string | null;
	grading_provider: string;
	graded_at: string;
	regraded_at: string | null;
	test_cases: unknown[];
	option_notes: unknown[];
	gradable_type: string;
	gradable_id: number;
}

export interface Course {
	id: number;
	name: string;
	university_id?: number;
}

export interface Subject {
	id: number;
	name: string;
	course_id: number;
}

export interface DifficultyRate {
	id: number;
	name: string;
}

export interface QuestionTypeLookup {
	id: number;
	key: QuestionType;
}

export interface Paginated<T> {
	data: T[];
	current_page: number;
	last_page: number;
	per_page: number;
	total: number;
}

export interface ApiErrorShape {
	status: number;
	message?: string;
	fieldErrors?: Record<string, string[]>;
	raw?: unknown;
}
