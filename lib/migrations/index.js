import removePullRequestTarget from './remove-pull-request-target.js';
import removeForkRoutingIf from './remove-fork-routing-if.js';
import addPushTrigger from './add-push-trigger.js';
import removeRestrictCustomActions from './remove-restrict-custom-actions.js';
import addNpmOidcPermissions from './add-npm-oidc-permissions.js';
import migrateCustomRunsOn from './migrate-custom-runs-on.js';

/**
 * The ordered migration registry. Adding a migration means writing one module
 * beside these and appending it here; nothing else in the tool changes.
 *
 * Units are independently applicable — each decides for itself whether it has
 * work to do — so a partially migrated workflow converges on a re-run.
 */
export const MIGRATIONS = [
	removePullRequestTarget,
	removeForkRoutingIf,
	addPushTrigger,
	removeRestrictCustomActions,
	addNpmOidcPermissions,
	migrateCustomRunsOn,
];
