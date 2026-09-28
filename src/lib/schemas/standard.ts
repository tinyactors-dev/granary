/**
 * TypeBox <-> Standard Schema v1 adapter, plus generic check/parse helpers.
 * ADR 0030.
 *
 * @sinclair/typebox 0.34 does not implement Standard Schema itself, so
 * `standard(schema)` wraps a TypeBox schema in a `~standard` object that
 * SvelteKit remote functions (`query`, `command`, `form`, `prerender`)
 * accept as their validator.
 *
 * This module has no SvelteKit or `$lib` imports on purpose: the fake GitHub
 * (plain Bun, no aliases) imports it through relative paths.
 */
import type { Static, TSchema } from '@sinclair/typebox';
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';

// ---------------------------------------------------------------------------
// Standard Schema v1 types (https://standardschema.dev), copied from
// @standard-schema/spec 1.x so we do not depend on a transitive package.
// Structurally identical, so SvelteKit's `StandardSchemaV1` constraint accepts it.
// ---------------------------------------------------------------------------

export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly '~standard': StandardSchemaV1Props<Input, Output>;
}

export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
	readonly version: 1;
	readonly vendor: string;
	readonly validate: (
		value: unknown
	) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
	readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

export type StandardSchemaV1Result<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<StandardSchemaV1Issue> };

export interface StandardSchemaV1Issue {
	readonly message: string;
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** A TypeBox schema that also speaks Standard Schema v1. */
export type TypeBoxStandardSchema<T extends TSchema> = StandardSchemaV1<Static<T>, Static<T>> & {
	/** The wrapped TypeBox schema. */
	readonly schema: T;
};

// ---------------------------------------------------------------------------
// Compiled checkers (lazy, cached per schema object)
// ---------------------------------------------------------------------------

const compiledCache = new WeakMap<TSchema, TypeCheck<TSchema>>();

/** The compiled checker for `schema`; compiled on first use and cached. */
export function compiled<T extends TSchema>(schema: T): TypeCheck<T> {
	let checker = compiledCache.get(schema);
	if (!checker) {
		checker = TypeCompiler.Compile(schema);
		compiledCache.set(schema, checker);
	}
	return checker as TypeCheck<T>;
}

/** One validation problem, with a path of object keys / array indices. */
export interface SchemaIssue {
	message: string;
	path: (string | number)[];
}

/**
 * Converts a TypeBox JSON-pointer error path (`/a/0/b`) into segments,
 * turning a segment into a number when the value at that point is an array.
 */
function pointerToPath(pointer: string, root: unknown): (string | number)[] {
	if (pointer === '' || pointer === '/') return [];
	const raw = pointer
		.split('/')
		.slice(1)
		.map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
	const path: (string | number)[] = [];
	let cursor: unknown = root;
	for (const segment of raw) {
		if (Array.isArray(cursor) && /^\d+$/.test(segment)) {
			const index = Number(segment);
			path.push(index);
			cursor = cursor[index];
		} else {
			path.push(segment);
			cursor =
				cursor !== null && typeof cursor === 'object'
					? (cursor as Record<string, unknown>)[segment]
					: undefined;
		}
	}
	return path;
}

/** All issues for `value` against `schema` (first message per path). Empty when valid. */
export function issuesOf<T extends TSchema>(schema: T, value: unknown): SchemaIssue[] {
	const checker = compiled(schema);
	if (checker.Check(value)) return [];
	const seen = new Set<string>();
	const issues: SchemaIssue[] = [];
	for (const error of checker.Errors(value)) {
		if (seen.has(error.path)) continue;
		seen.add(error.path);
		// A schema may carry a human message: Type.String({ errorMessage: '…' }).
		const custom = (error.schema as { errorMessage?: unknown }).errorMessage;
		const message = typeof custom === 'string' ? custom : error.message;
		issues.push({ message, path: pointerToPath(error.path, value) });
	}
	if (issues.length === 0) issues.push({ message: 'Invalid value', path: [] });
	return issues;
}

/** Thrown by `parse` / `parseJson` when a value does not match its schema. */
export class SchemaValidationError extends Error {
	readonly issues: SchemaIssue[];
	constructor(what: string, issues: SchemaIssue[]) {
		const detail = issues
			.slice(0, 5)
			.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
			.join('; ');
		super(`Invalid ${what}: ${detail}`);
		this.name = 'SchemaValidationError';
		this.issues = issues;
	}
}

/** Type guard: does `value` match `schema`? */
export function check<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
	return compiled(schema).Check(value);
}

/**
 * Returns `value` typed as `Static<T>`, or throws `SchemaValidationError`.
 * Does not clone, coerce or apply defaults.
 */
export function parse<T extends TSchema>(schema: T, value: unknown, what?: string): Static<T> {
	if (compiled(schema).Check(value)) return value;
	throw new SchemaValidationError(what ?? schema.$id ?? schema.title ?? 'value', issuesOf(schema, value));
}

/** `JSON.parse` + `parse`. A JSON syntax error is reported as a SchemaValidationError too. */
export function parseJson<T extends TSchema>(schema: T, text: string, what?: string): Static<T> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (e) {
		throw new SchemaValidationError(what ?? schema.$id ?? schema.title ?? 'JSON', [
			{ message: `Malformed JSON: ${(e as Error).message}`, path: [] }
		]);
	}
	return parse(schema, value, what);
}

/** Validates `value` and returns `JSON.stringify(value)`; throws `SchemaValidationError`. */
export function stringifyJson<T extends TSchema>(schema: T, value: Static<T>, what?: string): string {
	return JSON.stringify(parse(schema, value, what));
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Wraps a TypeBox schema as a Standard Schema v1 validator (vendor `typebox`).
 * Validation is synchronous and uses the compiled checker; issues carry
 * paths with numeric array indices, which SvelteKit forms map onto fields.
 *
 * ```ts
 * export const removeAllowedUser = command(standard(RemoveAllowedUserInput), async ({ login }) => …);
 * ```
 */
export function standard<T extends TSchema>(schema: T): TypeBoxStandardSchema<T> {
	return {
		schema,
		'~standard': {
			version: 1,
			vendor: 'typebox',
			validate(value: unknown): StandardSchemaV1Result<Static<T>> {
				if (compiled(schema).Check(value)) return { value: value as Static<T> };
				return { issues: issuesOf(schema, value) };
			}
		}
	};
}
