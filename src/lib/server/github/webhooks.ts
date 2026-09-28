/**
 * Webhook payload subsets for GitHub App lifecycle events (ADR 0160, 0192):
 * `installation` and `installation_repositories`, plus the `installation`
 * block every app-delivered event carries. Open objects: GitHub sends more.
 */
import { Type, type Static } from '@sinclair/typebox';
import { check } from '../../schemas/standard';

const open = { additionalProperties: true } as const;

const WebhookRepo = Type.Object({ id: Type.Integer(), full_name: Type.String() }, open);

const WebhookInstallation = Type.Object(
	{
		id: Type.Integer(),
		account: Type.Optional(Type.Object({ login: Type.String(), type: Type.String() }, open)),
		repository_selection: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('selected')])),
		suspended_at: Type.Optional(Type.Union([Type.String(), Type.Null()]))
	},
	open
);

export const InstallationEvent = Type.Object(
	{
		action: Type.String(),
		installation: WebhookInstallation,
		repositories: Type.Optional(Type.Array(WebhookRepo))
	},
	open
);
export type InstallationEvent = Static<typeof InstallationEvent>;

export const InstallationRepositoriesEvent = Type.Object(
	{
		action: Type.String(),
		installation: WebhookInstallation,
		repository_selection: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('selected')])),
		repositories_added: Type.Optional(Type.Array(WebhookRepo)),
		repositories_removed: Type.Optional(Type.Array(Type.Object({ id: Type.Integer() }, open)))
	},
	open
);
export type InstallationRepositoriesEvent = Static<typeof InstallationRepositoriesEvent>;

const WithInstallation = Type.Object({ installation: Type.Object({ id: Type.Integer() }, open) }, open);

/** `installation.id` of an app-delivered webhook body, or null. */
export function installationIdOf(body: unknown): number | null {
	return check(WithInstallation, body) ? body.installation.id : null;
}
