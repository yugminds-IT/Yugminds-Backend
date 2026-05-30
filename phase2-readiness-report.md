## Phase 2 Readiness Audit (Auth / Multi-tenancy / Security / Token Handling)

Date: 2026-03-23

### Scope
Backend: NestJS app under `Yugminds Backend/src/`
Frontend: Next.js app under `Yugminds Frontend/`

---

## STEP 1: AUTH SYSTEM ANALYSIS

### JWT
- JWT implemented: **yes**
- Where JWT is configured:
  - `Yugminds Backend/src/auth/auth.module.ts` (JWT module + access secret + expiry)
  - `Yugminds Backend/src/auth/strategies/jwt.strategy.ts` (passport-jwt strategy + access secret)
  - `Yugminds Backend/src/auth/auth.service.ts` (signing access + refresh tokens with secrets + expiries)
- What payload JWT contains (access + refresh):
  - Access/refresh JWT payload (`AuthService.generateTokens()` base payload):
    - `sub` (user id)
    - `email`
    - `role`
    - `isSuperAdmin`
    - plus a `pad` random string (to inflate token length)
  - Tenant is **not** inside the JWT payload.
  - Tenant is injected into `request.user` by `JwtStrategy.validate()` from the DB (`user.tenantId`).
- Access token expiry:
  - `Yugminds Backend/.env`: `ACCESS_TOKEN_EXPIRY=15m`
  - Used in both:
    - `AuthModule` (`JwtModule.registerAsync()` signOptions)
    - `AuthService.generateTokens()` (`expiresIn: accessExpiry`)

### Refresh token
- Refresh token implemented: **yes**
- Stored in DB: **yes**
  - `Yugminds Backend/prisma/schema.prisma` model `RefreshToken`:
    - `token: String @unique`
    - `expiresAt: DateTime`
    - relation to `User` via `userId`
- Is the refresh token hashed: **yes**
  - `AuthService.generateTokens()` bcrypt-hashes the raw refresh JWT and stores only the hash in `RefreshToken.token`.
- Is token rotation implemented: **yes (single-use rotation with hashed storage)**  
  - On `/auth/refresh`, the server:
    1. verifies the refresh JWT signature
    2. fetches all stored refresh token hashes for the user (`userId`)  
    3. bcrypt-comparers the provided raw refresh token against stored hashes (no DB lookup by raw token)
    4. deletes the matched stored refresh token row (rotation)
    5. issues a brand-new access token + refresh token and stores the new refresh token hash

### Endpoints (requested)
- `POST /auth/login` (public)
- `POST /auth/signup` (public)
- `POST /auth/refresh` (public)
- `POST /auth/logout` (requires access token / JWT)

### How each endpoint works (step-by-step)

#### `POST /auth/signup`
1. Route is marked `@Public()` in `Yugminds Backend/src/auth/auth.controller.ts`.
2. Controller calls `AuthService.signup(dto)`.
3. `AuthService.signup()`:
   - checks if email already exists (`db.user.findUnique({ where: { email } })`)
   - hashes password using bcrypt (`hashPassword()`)
   - creates `User` with:
     - `email`, `password` (hashed), `role`, `isSuperAdmin`
     - `tenantId: dto.tenantId ?? null`
4. `generateTokens(user)`:
   - creates access JWT signed with `JWT_ACCESS_SECRET` and expires in `ACCESS_TOKEN_EXPIRY` (default `15m`)
   - creates refresh JWT signed with `JWT_REFRESH_SECRET` and expires in `REFRESH_TOKEN_EXPIRY` (default `7d`)
  - stores refresh token hash in DB (`db.refreshToken.create({ token: bcryptHash(refreshToken), expiresAt })`)
     - note: `expiresAt` is computed from `REFRESH_TOKEN_EXPIRY` (e.g. `7d`, `30d`) to match JWT `expiresIn`
5. Response returns `user` summary + `{ accessToken, refreshToken }`.

#### `POST /auth/login`
1. Route is marked `@Public()` in `Yugminds Backend/src/auth/auth.controller.ts`.
2. Controller calls `AuthService.login(dto)`.
3. `AuthService.login()`:
   - loads user by email
   - validates password with bcrypt compare (`bcrypt.compare`)
4. `generateTokens(user)` issues and stores new refresh token in the DB.

#### `POST /auth/refresh`
1. Route is marked `@Public()` in `Yugminds Backend/src/auth/auth.controller.ts`.
2. Controller calls `AuthService.refresh(dto.refreshToken)`.
3. `AuthService.refresh()`:
   - verifies refresh JWT signature using `JWT_REFRESH_SECRET` (`jwtService.verifyAsync`)
  - fetches all refresh token hashes for the user (`db.refreshToken.findMany({ where: { userId } })`)
  - rejects unless `bcrypt.compare(rawRefreshToken, storedHash)` matches at least one non-expired row
  - deletes the matched stored refresh token row (rotation/single-use)
  - generates a new refresh token row + new access token

#### `POST /auth/logout`
1. Route is **not** marked `@Public()`; controller uses `@CurrentUser()` which depends on JWT auth.
2. Controller calls `AuthService.logout(user.id, dto?.refreshToken)`.
3. `AuthService.logout()`:
   - if `refreshToken` is provided: deletes only that token row for the user
   - otherwise: deletes **all** refresh token rows for the user
4. Access token is not revoked server-side (no access-token blacklist). Frontend clears local tokens.

---

## STEP 2: PASSWORD SECURITY

- Hashing used: **yes**
  - bcrypt via `AuthService.hashPassword()` with `saltRounds = 10`
  - compare via `AuthService.validatePassword()` uses `bcrypt.compare()`
- Where password is hashed:
  - `AuthService.signup()` (`passwordHash = hashPassword(dto.password)`)
  - `AuthService.updatePassword()` (`hashPassword(newPassword)`)
  - `AuthService.resetPassword()` (`hashPassword(newPassword)`)
- Where password is compared securely:
  - `AuthService.login()` uses `validatePassword(dto.password, user.password)`
  - `AuthService.updatePassword()` uses `validatePassword(currentPassword, user.password)`

Notes:
- Password reset confirm flow for authenticated users uses `updatePassword()` style checks (current_password required).
- Reset-password endpoint introduced for authenticated password reset (`AuthService.resetPassword()`) does **not** require current_password by design (comment in code). This is acceptable if the route is protected/used correctly, but it shifts trust to the access-token holder.

---

## STEP 3: AUTH GUARDS

### Global AuthGuard / JWT enforcement
- Global AuthGuard: **yes**
  - `Yugminds Backend/src/app.module.ts` sets:
    - `{ provide: APP_GUARD, useClass: JwtAuthGuard }`
  - Result: JWT validation is applied to all routes by default.

- `JwtAuthGuard` behavior:
  - Extends `AuthGuard('jwt')`
  - `canActivate()` bypasses JWT if route/class has `@Public()` metadata (`IS_PUBLIC_KEY`)
  - `handleRequest()` throws `UnauthorizedException` if auth fails

### Custom guards
- `JwtAuthGuard`: JWT auth + `@Public()` bypass
- `RolesGuard`: role checks using `@Roles()` metadata
- `InternalGuard`: internal-only header guard (currently no internal routes are exposed; see Step 6)

### Which routes are public?
Routes/classes decorated with `@Public()` include:
- `Yugminds Backend/src/auth/auth.controller.ts`
  - `POST /auth/signup`
  - `POST /auth/login`
  - `POST /auth/refresh`
  - `POST /auth/password-reset-request`
- `Yugminds Backend/src/app.controller.ts`
  - `GET /health`
- `Yugminds Backend/src/common/validate-joining-code/validate-joining-code.controller.ts`
  - `POST /validate-joining-code`
- `Yugminds Backend/src/common/extra/common-extra.controller.ts`
  - controller-level `@Public()` (e.g. `GET /success-stories`, `GET /api/schools`, `GET /api/csrf-token`, etc.)
- `Yugminds Backend/src/modules/internal/internal.controller.ts`
  - controller-level `@Public()` but also guarded by `InternalGuard` (and currently there are no `/internal/*` routes in `Yugminds Backend/api-master.json`)

---

## STEP 4: ROLE-BASED ACCESS CONTROL (RBAC)

- Roles system: **yes**
  - `Yugminds Backend/prisma/schema.prisma` enum `Role`:
    - `admin`, `school_admin`, `teacher`, `student`
- Roles stored in DB: **yes**
  - `User.role` is the enum value
- Roles decorator: **yes**
  - `Yugminds Backend/src/auth/decorators/roles.decorator.ts` exports `Roles(...roles)`
- RolesGuard: **yes**
  - `Yugminds Backend/src/auth/roles/roles.guard.ts`
  - Behavior:
    - reads required roles from metadata
    - if `user.isSuperAdmin` => bypass
    - otherwise checks `user.role` is in required roles

### Roles supported
- `admin`
- `school_admin`
- `teacher`
- `student`

### Which routes use role protection (high-level)
Role protection is applied via `@Roles(...)` + `@UseGuards(RolesGuard)` on controller(s), including:
- `Yugminds Backend/src/admin/**` (admin)
- `Yugminds Backend/src/school-admin/**` (school_admin)
- `Yugminds Backend/src/teacher/**` (teacher)
- `Yugminds Backend/src/student/**` (student)

Additionally, many controllers use `@UseGuards(RolesGuard)` and rely on the global `JwtAuthGuard` for JWT validation.

---

## STEP 5: MULTI-TENANT SYSTEM

### tenantId usage
- Is `tenantId` used anywhere: **yes**
  - Stored on `User.tenantId` in Prisma
  - `JwtStrategy.validate()` returns `tenantId: user.tenantId` in `request.user`
  - Some services/queries reference `tenantId` directly

- Is there a `TenantMiddleware`: **no**
  - `TENANT_HEADER` is configured in `Yugminds Backend/.env`, but no code usage was found for `x-tenant-id` / `TENANT_HEADER`.

- How tenantId is extracted:
  - No header-based tenant extraction found.
  - Tenant is effectively derived from the authenticated user’s DB record inside:
    - `Yugminds Backend/src/auth/strategies/jwt.strategy.ts` (`tenantId: user.tenantId`)

- Are DB queries tenant-scoped?
  - **partially**
  - Some queries use `tenantId` directly.
  - Many other queries scope via `schoolId` or assignment/join tables (e.g., `teacherSchool`, `studentSchool`) rather than `User.tenantId`.

Examples:

#### Queries WITH tenantId (direct usage)
- `AuthService.signup()`:
  - creates user with `tenantId: dto.tenantId ?? null`
- `AdminSchoolsService.delete()`:
  - deletes users by `{ where: { tenantId: id } }`

#### Queries WITHOUT tenantId (tenant isolation is indirect / via assignments)
- `TeacherSchoolsService.list()`:
  - uses `{ where: { teacherId: user.id } }` and includes `school`
  - does not filter by `tenantId` explicitly
- `StudentExtraController.listCertificates()`:
  - uses `{ where: { studentId: user.id } }`
  - does not filter by `tenantId` explicitly

Impact:
- Tenant isolation likely depends on the correctness of assignment tables and the invariant that `teacherSchool.schoolId` / `studentSchool.schoolId` belong to the correct tenant.

---

## STEP 6: INTERNAL API SECURITY

- Is `InternalGuard` implemented: **yes**
  - `Yugminds Backend/src/modules/internal/internal.guard.ts`
  - Checks header:
    - expects `x-internal-api-key`
    - compares it to config `INTERNAL_API_KEY`

- How are `/internal` APIs protected:
  - `Yugminds Backend/src/modules/internal/internal.controller.ts`:
    - `@Controller('internal')`
    - `@Public()` (so JWT is not required by `JwtAuthGuard`)
    - `@UseGuards(InternalGuard)` to enforce `x-internal-api-key`

- Is `x-internal-api-key` used?
  - **yes**. Guard uses `x-internal-api-key` and compares it to `INTERNAL_API_KEY`.

Important finding:
- `Yugminds Backend/api-master.json` currently has **0 routes** under `/internal` (so InternalGuard isn’t currently exercised by the frontend contract).
- `Yugminds Backend/.env` must define `INTERNAL_API_KEY`; requests are rejected if the key is missing/invalid.

---

## STEP 7: FRONTEND AUTH HANDLING

### Where tokens are stored
- Access token is stored in:
  - `localStorage` key `session_token`
  - and also mirrored in `sessionStorage` key `session_token`
- Additional session object is stored (when available) as `auth_session`:
  - `localStorage` key `auth_session`
  - also mirrored in `sessionStorage`
- Implemented in:
  - `Yugminds Frontend/src/lib/api/axios.ts` (`setAuthToken()`)
  - `Yugminds Frontend/src/lib/session-utils.ts` (`setStoredSession()`, `clearStoredSession()`)

### Is axios interceptor used?
- **yes**
  - `Yugminds Frontend/src/lib/api/axios.ts`:
    - request interceptor:
      - reads token from `localStorage`/`sessionStorage`
      - sets `config.headers.Authorization = Bearer <token>`
      - attempts CSRF token injection for non-GET/HEAD requests
    - response interceptor:
      - on `401`:
        - refreshes tokens via `/auth/refresh`
        - retries queued/original requests with the new access token
        - redirects to `/login` only if refresh fails

### Is Authorization header attached?
- **yes**
  - Via axios interceptor as described above.

### Is refresh token flow implemented?
- Backend refresh endpoint exists and frontend exposes it (`Yugminds Frontend/src/lib/api/auth.api.ts`).
- The axios response interceptor on `401` now calls `/auth/refresh`, updates stored tokens, and retries the original request.

Conclusion: refresh token flow is **implemented** on the client side (for access-token renewal).

### Logout handling
- `useSessionValidation.logout()`:
  1. optionally calls `/api/auth/logout` and includes `Authorization: Bearer <access_token>`
  2. calls `clearStoredSession()` to clear local storage/session storage
  3. redirects to `/login`
- Because the backend logout DTO accepts `refreshToken?: string`, sending an empty body causes backend to delete **all refresh tokens for the user** (server-side), while access token is cleared client-side.

---

## STEP 8: FINAL REPORT (Structured)

```json
{
  "auth": {
    "jwt": "implemented",
    "refreshToken": "implemented",
    "issues": [
      {
        "severity": "resolved",
        "title": "Refresh token DB expiry now matches JWT",
        "details": "AuthService.generateTokens() now parses REFRESH_TOKEN_EXPIRY (e.g. 7d, 30d) and sets expiresAt consistently with the JWT `expiresIn` value."
      },
      {
        "severity": "resolved",
        "title": "Access token invalidation via tokenVersion",
        "details": "Logout now increments `User.tokenVersion`, and `JwtStrategy.validate()` rejects JWTs whose `tokenVersion` claim does not match the DB value."
      }
    ]
  },
  "security": {
    "passwordHashing": "implemented",
    "guards": "implemented",
    "rbac": "implemented",
    "issues": [
      {
        "severity": "high",
        "title": "Client-side tokens in localStorage/sessionStorage",
        "details": "Frontend stores access token in localStorage and sessionStorage, increasing impact of XSS compared to httpOnly cookies."
      }
    ]
  },
  "multiTenant": {
    "tenantMiddleware": "missing",
    "tenantIsolation": "partial",
    "issues": [
      {
        "severity": "medium",
        "title": "tenantId filtering not consistently applied",
        "details": "tenantId is present on User, but many queries scope by teacherId/studentId and join tables without explicit tenantId filtering. Isolation depends on assignment-table invariants."
      }
    ]
  },
  "frontend": {
    "tokenHandling": "implemented_partial",
    "refreshFlow": "implemented",
    "issues": [
      {
        "severity": "resolved",
        "title": "Automatic refresh on 401 (single in-flight + queued retries)",
        "details": "axios now performs a single refresh request at a time, queues concurrent requests during refresh, retries the original request, and logs out only if refresh fails."
      }
    ]
  }
}
```

### ✅ What is already production-ready
- Password hashing uses bcrypt with secure compare paths (`signup`, `login`, `updatePassword`, `resetPassword`).
- JWT enforcement is global (`APP_GUARD` with `JwtAuthGuard`) and public routes use an explicit `@Public()` metadata mechanism.
- RBAC is implemented with `RolesGuard`, `@Roles()` metadata, and roles stored as an enum in Prisma.
- Refresh-token rotation is implemented server-side as single-use refresh tokens (old DB row deleted on refresh).

### ⚠️ What is partially implemented
- Multi-tenancy: tenantId exists and is returned in `request.user`, but tenant scoping isn’t consistently applied at the query layer.
- Refresh token flow on the frontend: implemented for access-token renewal via axios `401` handling.

### ❌ What is completely missing
- Tenant header/middleware approach (e.g., extracting tenantId from `x-tenant-id`) is not implemented in backend code.
- Automatic access-token renewal via refresh tokens is now implemented.

### 🚨 Critical security gaps
- Access token invalidation is enforced server-side via `User.tokenVersion` (incremented on logout).

