/**
 * Host half of the unread badge bundle.
 *
 * Everything this plugin does happens in the renderer (`./client.js`): the
 * Dock badge comes from `navigator.setAppBadge()` and the Workspace dots are
 * DOM decorations. No Host route, no storage, no tool — this entry exists so
 * the bundle row resolves and the client half is discovered through the
 * `dsh.client` declaration in package.json.
 */
export function apply() {}
