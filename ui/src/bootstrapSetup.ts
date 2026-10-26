export const BOOTSTRAP_FALLBACK_COMMAND = "npx paperclipai auth bootstrap-ceo";
/**
 * Host-side first admin: creates the operator with its login on a fresh authenticated install, or attaches
 * a login to the existing operator of a database that already ran without login (doc/DEPLOYMENT-MODES.md
 * sections 8 and 8.1).
 */
export const OPERATOR_CREDENTIALS_COMMAND = "npx paperclipai auth set-operator-credentials --email <email>";
