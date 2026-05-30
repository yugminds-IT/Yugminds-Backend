# Teacher API – Response Structure

Admin teacher endpoints return enriched teacher details for UI and management.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/teachers` | List teachers (optional `?school_id=`) |
| GET | `/admin/teachers/:id` | Get one teacher by ID |
| POST | `/admin/teachers` | Create teacher |
| PUT | `/admin/teachers/:id` | Update teacher |

All require **admin** role (JWT).

---

## Response: Teacher detail (single or list item)

Used by **GET /admin/teachers** (each item in `teachers` array), **GET /admin/teachers/:id**, **POST /admin/teachers**, and **PUT /admin/teachers/:id**.

```json
{
  "id": 1,
  "email": "teacher@school.com",
  "name": "Jane Doe",
  "phone": "+1234567890",
  "qualification": "B.Ed, M.Sc",
  "experience": "5 years",
  "status": "active",
  "assignedSchools": [
    {
      "schoolId": "uuid-school-1",
      "schoolName": "Dawn Buds Model School",
      "gradesAssigned": ["Grade 1", "Grade 2"]
    }
  ],
  "createdAt": "2026-03-15T12:00:00.000Z",
  "role": "teacher",
  "tenantId": "uuid-tenant-or-null"
}
```

### Field description

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Teacher user ID |
| `email` | string | Login email |
| `name` | string | Full name (from profile) |
| `phone` | string \| null | Contact number (from profile) |
| `qualification` | string \| null | Educational qualifications (from profile) |
| `experience` | string \| null | Years or description of teaching experience (from profile) |
| `status` | string | `"active"` or `"inactive"` (from `User.isActive`) |
| `assignedSchools` | array | Schools the teacher is assigned to (see below) |
| `createdAt` | string (ISO date) | Account creation time |
| `role` | string | Always `"teacher"` |
| `tenantId` | string \| null | Tenant/school ID if linked |

### assignedSchools[]

Each element:

| Field | Type | Description |
|-------|------|-------------|
| `schoolId` | string | School UUID |
| `schoolName` | string | School display name |
| `gradesAssigned` | string[] | List of grade names (e.g. `["Grade 1", "Grade 2"]`) |

---

## List response: GET /admin/teachers

```json
{
  "teachers": [
    { /* TeacherDetailResponse as above */ }
  ]
}
```

Optional query: `?school_id=<uuid>` to filter by school (tenant).

---

## Create/Update request body (relevant fields)

- **name / full_name**: Stored in profile as `fullName`.
- **phone**, **qualification**, **experience**: Stored in profile.
- **isActive**: Optional; sets user status (true/false).
- **school_assignments**: Array of `{ school_id, grades_assigned, grade_sections_assigned, subjects, working_days_per_week }` for section-level assignment.

Sensitive fields (e.g. `password`) are never returned in the response.

---

## Access control

- All admin teacher routes require **admin** role (enforced by `RolesGuard`).
- Response does not include `password` or other sensitive auth data.
