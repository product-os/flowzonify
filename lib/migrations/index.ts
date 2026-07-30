import removePullRequestTarget from './remove-pull-request-target.ts';
import removeForkRoutingIf from './remove-fork-routing-if.ts';
import addPushTrigger from './add-push-trigger.ts';
import removeRestrictCustomActions from './remove-restrict-custom-actions.ts';
import addNpmOidcPermissions from './add-npm-oidc-permissions.ts';
import migrateCustomRunsOn from './migrate-custom-runs-on.ts';

import type { Migration } from '../migrate.ts';

/**
 * The migration registry. Adding a migration means writing one module beside
 * these and appending it here; nothing else in the tool changes.
 *
 * The array order is the order `migrate` applies them in, and nothing more: it
 * reparses between units, so each one reasons about the previous one's output and
 * no unit depends on a sibling having run first. Units are independently
 * applicable — each decides for itself whether it has work to do — so a partially
 * migrated workflow converges on a re-run.
 */
export const MIGRATIONS: Migration[] = [
	removePullRequestTarget,
	removeForkRoutingIf,
	addPushTrigger,
	removeRestrictCustomActions,
	addNpmOidcPermissions,
	migrateCustomRunsOn,
];
