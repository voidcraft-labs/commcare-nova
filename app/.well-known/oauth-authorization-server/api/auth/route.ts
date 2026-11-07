/** RFC 8414 inserts the discovery suffix before the canonical issuer path.
 * Keep this explicit route: Better Auth's handler only receives /api/auth/*.
 */
export { GET } from "../../route";
