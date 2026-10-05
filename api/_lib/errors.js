// Errors the API answers with: a code (the database raises "OBV:<code>", the D1 functions throw it directly) and its
// HTTP status, plus optional detail for the browser.
class ApiError extends Error {
  constructor(code, status, detail) { super(code); this.code = code; this.status = status; this.detail = detail || null; }
}
// database error codes (raised as "OBV:<code>") -> HTTP status
const STATUS = {
  not_found: 404, expired: 410, forbidden: 403, suspended: 403, no_user: 403, conflict: 409, too_large: 413, too_many_pending: 429,
  storage_full: 507, storage_limit: 503, too_many_projects: 429, too_many_members: 429, bad_request: 400, bad_files: 400, bad_manifest: 400,
  missing_upload: 400, size_mismatch: 400, save_expired: 410, expiry_immutable: 400, not_deleting: 409, bad_user: 400, saving_disabled: 503, too_soon: 429, invite_full: 409, invite_inactive: 403, already_on_d1: 409, d1_not_bound: 409,
};

module.exports = { ApiError, STATUS };
