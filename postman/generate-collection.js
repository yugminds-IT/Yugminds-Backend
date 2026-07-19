// Generates postman/Yugminds-Backend.postman_collection.json from a route table.
// Run: node postman/generate-collection.js
// Re-run this after adding/removing/changing backend routes rather than
// hand-editing the generated JSON directly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();

// ---- helpers ----------------------------------------------------------

function req({ name, method, url, query = [], body = null, auth = 'inherit', isFile = false, description = '' }) {
  const item = {
    name,
    request: {
      method,
      header: [],
      url: buildUrl(url, query),
      description,
    },
    response: [],
  };
  if (auth === 'none') {
    item.request.auth = { type: 'noauth' };
  }
  if (isFile && body) {
    item.request.body = {
      mode: 'formdata',
      formdata: body.map((f) => ({
        key: f.key,
        type: f.type === 'file' ? 'file' : 'text',
        value: f.type === 'file' ? undefined : f.value,
        src: f.type === 'file' ? [] : undefined,
        disabled: false,
      })),
    };
  } else if (body) {
    item.request.header.push({ key: 'Content-Type', value: 'application/json' });
    item.request.body = {
      mode: 'raw',
      raw: JSON.stringify(body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  return item;
}

function buildUrl(rawPath, query) {
  const segments = rawPath.split('/').filter(Boolean);
  const pathParts = segments.map((s) => (s.startsWith(':') ? `{{${s.slice(1)}}}` : s));
  return {
    raw: `{{baseUrl}}/${pathParts.join('/')}${query.length ? '?' + query.map((q) => `${q.key}=${q.value ?? ''}`).join('&') : ''}`,
    host: ['{{baseUrl}}'],
    path: pathParts,
    query: query.map((q) => ({ key: q.key, value: q.value ?? '', disabled: !!q.disabled })),
  };
}

function folder(name, items, description = '') {
  return { name, description, item: items };
}

// ---- AUTH ---------------------------------------------------------------

const authFolder = folder('Auth', [
  req({
    name: 'Signup',
    method: 'POST',
    url: '/auth/signup',
    auth: 'none',
    body: { email: 'newuser@example.com', password: 'ChangeMe123!', role: 'student', tenantId: '' },
  }),
  {
    ...req({
      name: 'Login',
      method: 'POST',
      url: '/auth/login',
      auth: 'none',
      body: { email: 'admin@yugminds.com', password: 'Admin@123' },
      description: 'Sets a `refresh_token` httpOnly cookie. Test script auto-saves accessToken into the collection variable.',
    }),
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            'const json = pm.response.json();',
            'if (json && json.tokens && json.tokens.accessToken) {',
            '  pm.collectionVariables.set("accessToken", json.tokens.accessToken);',
            '  console.log("accessToken saved to collection variable");',
            '}',
          ],
        },
      },
    ],
  },
  req({
    name: 'Refresh Token',
    method: 'POST',
    url: '/auth/refresh',
    auth: 'none',
    description: 'Uses the `refresh_token` cookie set by Login. Requires cookie jar enabled in Postman.',
  }),
  req({
    name: 'Password Reset Request',
    method: 'POST',
    url: '/auth/password-reset-request',
    auth: 'none',
    body: { email: 'someone@example.com' },
  }),
  req({
    name: 'Verify Reset Token',
    method: 'POST',
    url: '/auth/verify-reset-token',
    auth: 'none',
    body: { requestId: '', token: '' },
  }),
  req({
    name: 'Complete Password Reset',
    method: 'POST',
    url: '/auth/complete-password-reset',
    auth: 'none',
    body: { requestId: '', token: '', newPassword: 'NewPassword123!' },
  }),
  req({
    name: 'Verify Password',
    method: 'POST',
    url: '/auth/verify-password',
    body: { current_password: 'Admin@123' },
  }),
  req({
    name: 'Update Password',
    method: 'POST',
    url: '/auth/update-password',
    body: { current_password: 'Admin@123', new_password: 'NewPassword123!' },
  }),
  req({
    name: 'Logout',
    method: 'POST',
    url: '/auth/logout',
    body: { refreshToken: '' },
  }),
  req({
    name: 'API Logout',
    method: 'POST',
    url: '/api/auth/logout',
    body: { refreshToken: '' },
  }),
  req({
    name: 'API Reset Password',
    method: 'POST',
    url: '/api/auth/reset-password',
    body: { password: 'NewPassword123!' },
  }),
]);

// ---- COMMON / PUBLIC ------------------------------------------------------

const publicFolder = folder('Public', [
  req({ name: 'Root', method: 'GET', url: '/', auth: 'none' }),
  req({ name: 'Health Check', method: 'GET', url: '/health', auth: 'none' }),
  req({ name: 'System Status', method: 'GET', url: '/system-status', auth: 'none' }),
  req({ name: 'Community (public)', method: 'GET', url: '/community', auth: 'none' }),
  req({
    name: 'Validate Joining Code',
    method: 'POST',
    url: '/validate-joining-code',
    auth: 'none',
    body: {
      code: 'ABC123',
      studentData: { full_name: 'Jane Doe', email: 'jane@example.com', password: 'ChangeMe123!', parent_name: '', parent_phone: '' },
    },
  }),
  req({ name: 'Public Logos', method: 'GET', url: '/api/logos', auth: 'none', query: [{ key: 'limit', value: '20' }] }),
  req({ name: 'Public Schools', method: 'GET', url: '/api/schools', auth: 'none', query: [{ key: 'q', value: '' }, { key: 'limit', value: '20' }] }),
  req({ name: 'CSRF Token', method: 'GET', url: '/api/csrf-token', auth: 'none' }),
  req({
    name: 'Contact',
    method: 'POST',
    url: '/contact',
    auth: 'none',
    body: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', areaCode: '+91', phoneNumber: '', purpose: 'general', message: 'Hello' },
  }),
  req({
    name: 'Track Login',
    method: 'POST',
    url: '/auth/track-login',
    auth: 'none',
    body: { user_id: 0, email: '', success: true, failure_reason: '', ip_address: '', user_agent: '', action: 'login', metadata: {} },
  }),
  req({ name: 'Auth Redirect', method: 'GET', url: '/auth/redirect', auth: 'none' }),
  req({ name: 'Metrics', method: 'GET', url: '/metrics', auth: 'none' }),
  req({ name: 'Cache Status', method: 'GET', url: '/cache/status', auth: 'none' }),
  req({ name: 'Verify Certificate', method: 'GET', url: '/verify/:shortId', auth: 'none' }),
]);

const commonFolder = folder('Common (any authenticated role)', [
  req({ name: 'Get Role', method: 'GET', url: '/get-role', query: [{ key: 'userId', value: '' }] }),
  req({
    name: 'Auth Activity - List',
    method: 'GET',
    url: '/auth/activity',
    query: [{ key: 'limit', value: '20' }, { key: 'user_id', value: '' }],
  }),
  req({
    name: 'Auth Activity - Record',
    method: 'POST',
    url: '/auth/activity',
    body: { action: 'login', success: true, failure_reason: '', ip_address: '', user_agent: '', metadata: {} },
  }),
  req({
    name: 'Upload File (course/thumbnail/material)',
    method: 'POST',
    url: '/admin/upload',
    isFile: true,
    body: [
      { key: 'type', type: 'text', value: 'thumbnail' },
      { key: 'courseId', type: 'text', value: '' },
      { key: 'chapterId', type: 'text', value: '' },
      { key: 'file', type: 'file' },
    ],
  }),
  req({ name: 'Get Notifications - Unread Count', method: 'GET', url: '/notifications/unread-count' }),
  req({
    name: 'Get Notifications - List',
    method: 'GET',
    url: '/notifications/user',
    query: [{ key: 'filter', value: 'all' }, { key: 'limit', value: '20' }],
  }),
  req({
    name: 'Update Notification',
    method: 'PATCH',
    url: '/notifications/user',
    body: { notification_id: '', is_read: true, deleted: false, mark_all: false },
  }),
  req({ name: 'Get Notification Reply', method: 'GET', url: '/notifications/reply', query: [{ key: 'notification_id', value: '' }] }),
  req({
    name: 'Reply to Notification',
    method: 'POST',
    url: '/notifications/reply',
    body: { notification_id: '', reply_text: '' },
  }),
  req({ name: 'Get My Profile', method: 'GET', url: '/profile', query: [{ key: 'userId', value: '' }] }),
  req({
    name: 'Update My Profile',
    method: 'PATCH',
    url: '/profile',
    body: { full_name: '', phone: '' },
  }),
]);

// ---- ADMIN ----------------------------------------------------------------

const adminCore = folder('Admin - Core', [
  req({ name: 'Alerts', method: 'GET', url: '/admin/alerts' }),
  req({ name: 'Audit Logs', method: 'GET', url: '/admin/audit-logs', query: [{ key: 'limit', value: '50' }] }),
  req({ name: 'Audit Log Entity Types', method: 'GET', url: '/admin/audit-logs/entity-types' }),
  req({ name: 'Stats', method: 'GET', url: '/admin/stats' }),
  req({ name: 'Analytics', method: 'GET', url: '/admin/analytics', query: [{ key: 'from', value: '' }, { key: 'to', value: '' }] }),
  req({ name: 'Assignment Analytics', method: 'GET', url: '/admin/assignment-analytics' }),
  req({ name: 'Refresh Dashboard Views', method: 'POST', url: '/admin/refresh-dashboard-views' }),
  req({ name: 'Monitoring Dashboard', method: 'GET', url: '/admin/monitoring-dashboard' }),
  req({ name: 'Materialized View Stats', method: 'GET', url: '/admin/materialized-view-stats' }),
  req({ name: 'Digest Preview', method: 'GET', url: '/admin/digest/preview' }),
  req({ name: 'Digest Run', method: 'POST', url: '/admin/digest/run' }),
  req({ name: 'Trash - List', method: 'GET', url: '/admin/trash' }),
  req({ name: 'Trash - Restore', method: 'POST', url: '/admin/trash/restore', body: { entity_type: 'students', id: '' } }),
  req({ name: 'Trash - Purge', method: 'DELETE', url: '/admin/trash', query: [{ key: 'entity_type', value: 'students' }, { key: 'id', value: '' }] }),
  req({ name: 'Search', method: 'GET', url: '/admin/search', query: [{ key: 'q', value: '' }] }),
  req({ name: 'Impersonate User', method: 'POST', url: '/admin/impersonate', body: { user_id: 0 } }),
  req({ name: 'System Controls - Get', method: 'GET', url: '/admin/system-controls' }),
  req({ name: 'System Controls - Update', method: 'PATCH', url: '/admin/system-controls', body: { maintenance_mode: false, maintenance_message: '' } }),
]);

const adminSchools = folder('Admin - Schools', [
  req({ name: 'List Schools', method: 'GET', url: '/admin/schools', query: [{ key: 'limit', value: '50' }, { key: 'offset', value: '0' }] }),
  req({ name: 'Get School', method: 'GET', url: '/admin/schools/:id' }),
  req({ name: 'School Teacher Assignments', method: 'GET', url: '/admin/schools/:id/teacher-assignments' }),
  req({ name: 'Create School', method: 'POST', url: '/admin/schools', body: { name: 'New School', domain: 'new-school' } }),
  req({ name: 'Update School', method: 'PUT', url: '/admin/schools', body: { id: '', name: '', domain: '' } }),
  req({ name: 'Init Academic Structure', method: 'POST', url: '/admin/schools/:id/init-academic-structure' }),
  req({ name: 'Delete School', method: 'DELETE', url: '/admin/schools/:id' }),
]);

const adminStudents = folder('Admin - Students', [
  req({
    name: 'List Students',
    method: 'GET',
    url: '/admin/students',
    query: [{ key: 'school_id', value: '' }, { key: 'limit', value: '50' }, { key: 'page', value: '1' }, { key: 'search', value: '' }],
  }),
  req({ name: 'Get Student', method: 'GET', url: '/admin/students/:studentId' }),
  req({
    name: 'Create Student',
    method: 'POST',
    url: '/admin/students',
    body: { email: 'student@example.com', password: 'ChangeMe123!', full_name: '', school_id: '', grade: '', section: '' },
  }),
  req({ name: 'Bulk Student Action', method: 'POST', url: '/admin/students/bulk', body: { action: 'activate', student_ids: [], school_id: '', grade: '', section: '' } }),
  req({ name: 'Sync Enrollments', method: 'POST', url: '/admin/students/sync-enrollments', query: [{ key: 'school_id', value: '' }] }),
  req({ name: 'Enroll Student', method: 'POST', url: '/admin/students/:studentId/enroll' }),
  req({ name: 'Update Student', method: 'PATCH', url: '/admin/students/:studentId', body: { full_name: '', grade: '', section: '' } }),
  req({ name: 'Delete Student', method: 'DELETE', url: '/admin/students/:studentId' }),
]);

const adminTeachers = folder('Admin - Teachers', [
  req({ name: 'List Teachers', method: 'GET', url: '/admin/teachers', query: [{ key: 'school_id', value: '' }, { key: 'limit', value: '50' }] }),
  req({ name: 'Get Teacher', method: 'GET', url: '/admin/teachers/:id' }),
  req({ name: 'Create Teacher', method: 'POST', url: '/admin/teachers', body: { email: 'teacher@example.com', password: 'ChangeMe123!', full_name: '' } }),
  req({ name: 'Bulk Teacher Action', method: 'POST', url: '/admin/teachers/bulk', body: { action: 'activate', teacher_ids: [] } }),
  req({ name: 'Update Teacher', method: 'PUT', url: '/admin/teachers/:id', body: { full_name: '' } }),
  req({ name: 'Delete Teacher', method: 'DELETE', url: '/admin/teachers/:id' }),
  req({ name: 'Teacher Attendance', method: 'GET', url: '/admin/teacher-attendance', query: [{ key: 'school_id', value: '' }, { key: 'from', value: '' }, { key: 'to', value: '' }] }),
  req({ name: 'Teacher Attendance Monthly', method: 'GET', url: '/admin/teacher-attendance/monthly', query: [{ key: 'month', value: '' }, { key: 'school_id', value: '' }] }),
  req({ name: 'Mark Missing Attendance', method: 'POST', url: '/admin/teacher-attendance/mark-missing', body: { start_date: '', end_date: '' } }),
  req({ name: 'Teacher Reports', method: 'GET', url: '/admin/teacher-reports', query: [{ key: 'school_id', value: '' }, { key: 'limit', value: '50' }] }),
  req({ name: 'Update Teacher Report', method: 'PATCH', url: '/admin/teacher-reports', body: { id: '', status: 'reviewed', admin_notes: '' } }),
]);

const adminSchoolAdmins = folder('Admin - School Admins', [
  req({ name: 'List School Admins', method: 'GET', url: '/admin/school-admins', query: [{ key: 'search', value: '' }, { key: 'status', value: '' }] }),
  req({ name: 'Create School Admin', method: 'POST', url: '/admin/school-admins', body: { email: 'schooladmin@example.com', password: 'ChangeMe123!', full_name: '', school_id: '' } }),
  req({ name: 'Update School Admin', method: 'PUT', url: '/admin/school-admins', body: { id: '', full_name: '' } }),
  req({ name: 'Delete School Admin', method: 'DELETE', url: '/admin/school-admins', body: { id: '' } }),
]);

const adminCourses = folder('Admin - Courses', [
  req({ name: 'List Courses', method: 'GET', url: '/admin/courses', query: [{ key: 'limit', value: '50' }] }),
  req({ name: 'Get Course', method: 'GET', url: '/admin/courses/:courseId' }),
  req({ name: 'Course Versions', method: 'GET', url: '/admin/courses/:courseId/versions' }),
  req({ name: 'Course Chapters', method: 'GET', url: '/admin/courses/:courseId/chapters' }),
  req({ name: 'Create Course', method: 'POST', url: '/admin/courses', body: { title: 'New Course', description: '' } }),
  req({ name: 'Publish Course', method: 'POST', url: '/admin/courses/:courseId/publish', body: { publish: true, changes_summary: '' } }),
  req({ name: 'Duplicate Course', method: 'POST', url: '/admin/courses/:courseId/duplicate' }),
  req({ name: 'Update Course', method: 'PATCH', url: '/admin/courses/:courseId', body: { title: '' } }),
  req({ name: 'Delete Course', method: 'DELETE', url: '/admin/courses/:courseId' }),
  req({ name: 'Restore Course Version', method: 'PATCH', url: '/admin/courses/:courseId/versions', body: { version_id: '', version_number: 1 } }),
  req({ name: 'Create Chapter', method: 'POST', url: '/admin/courses/:courseId/chapters', body: { title: 'New Chapter' } }),
  req({ name: 'Set Course Access', method: 'POST', url: '/admin/courses/:courseId/access', body: { school_ids: [], grades: [] } }),
]);

const adminCertificates = folder('Admin - Certificates & Logos', [
  req({ name: 'List Certificates', method: 'GET', url: '/admin/certificates', query: [{ key: 'page', value: '1' }, { key: 'limit', value: '50' }] }),
  req({ name: 'Generate All Eligible Certificates', method: 'POST', url: '/admin/certificates/generate-all-eligible' }),
  req({ name: 'Batch Generate Certificates', method: 'POST', url: '/admin/certificates/batch-generate', body: { course_ids: [], student_ids: [], dry_run: true } }),
  req({ name: 'Regenerate Certificate', method: 'POST', url: '/admin/certificates/:id/regenerate' }),
  req({ name: 'Delete Certificate', method: 'DELETE', url: '/admin/certificates/:id' }),
  req({ name: 'Get Certificate Template', method: 'GET', url: '/admin/certificate-template' }),
  req({ name: 'Set Certificate Template', method: 'POST', url: '/admin/certificate-template', body: { template: '' } }),
  req({ name: 'Delete Certificate Template', method: 'DELETE', url: '/admin/certificate-template' }),
  req({ name: 'List Logos', method: 'GET', url: '/admin/logos', query: [{ key: 'limit', value: '50' }] }),
  req({ name: 'Get Logo', method: 'GET', url: '/admin/logos/:id' }),
  req({
    name: 'Create Logo',
    method: 'POST',
    url: '/admin/logos',
    isFile: true,
    body: [
      { key: 'school_name', type: 'text', value: '' },
      { key: 'school_id', type: 'text', value: '' },
      { key: 'description', type: 'text', value: '' },
      { key: 'file', type: 'file' },
    ],
  }),
  req({
    name: 'Replace Logo',
    method: 'PUT',
    url: '/admin/logos/:id',
    isFile: true,
    body: [
      { key: 'school_name', type: 'text', value: '' },
      { key: 'school_id', type: 'text', value: '' },
      { key: 'description', type: 'text', value: '' },
      { key: 'replace_image', type: 'text', value: 'true' },
      { key: 'file', type: 'file' },
    ],
  }),
  req({ name: 'Delete Logo', method: 'DELETE', url: '/admin/logos/:id', query: [{ key: 'hard', value: 'false' }] }),
]);

const adminSettingsSecurity = folder('Admin - Settings, Security & Notifications', [
  req({ name: 'Get Settings', method: 'GET', url: '/admin/settings' }),
  req({ name: 'Update Settings (POST)', method: 'POST', url: '/admin/settings', body: {} }),
  req({ name: 'Update Settings (PATCH)', method: 'PATCH', url: '/admin/settings', body: {} }),
  req({ name: 'Export Settings (POST)', method: 'POST', url: '/admin/settings/export' }),
  req({ name: 'Export Settings (GET)', method: 'GET', url: '/admin/settings/export' }),
  req({ name: 'Backup Settings', method: 'POST', url: '/admin/settings/backup' }),
  req({ name: 'Cleanup', method: 'POST', url: '/admin/settings/cleanup' }),
  req({ name: 'Update Notification Settings', method: 'PATCH', url: '/admin/settings/notifications', body: {} }),
  req({ name: 'Get Security Settings', method: 'GET', url: '/admin/security' }),
  req({ name: 'MFA Action', method: 'POST', url: '/admin/security/mfa', body: { action: 'enable', code: '', factorId: '' } }),
  req({ name: 'MFA Disable', method: 'DELETE', url: '/admin/security/mfa', query: [{ key: 'factorId', value: '' }] }),
  req({ name: 'Get Notifications', method: 'GET', url: '/admin/notifications', query: [{ key: 'limit', value: '20' }] }),
  req({ name: 'Send Notification', method: 'POST', url: '/admin/notifications', body: { title: '', message: '', type: 'info', recipientType: 'all', recipients: [], allowReplies: true } }),
  req({ name: 'Notification Recipients', method: 'GET', url: '/admin/notifications/recipients' }),
  req({ name: 'Reports (PDF)', method: 'GET', url: '/admin/reports', query: [{ key: 'type', value: '' }] }),
  req({ name: 'Restore All Data', method: 'POST', url: '/admin/restore-all-data' }),
  req({ name: 'Cache Monitor', method: 'GET', url: '/admin/cache-monitor' }),
  req({ name: 'Warm Cache', method: 'POST', url: '/admin/warm-cache' }),
]);

const adminMisc = folder('Admin - Password Resets, Joining Codes, Leaves, Licenses, Profile, Saved Views, Contact', [
  req({ name: 'Pending Password Reset Count', method: 'GET', url: '/admin/password-reset-requests/pending-count' }),
  req({ name: 'List Password Reset Requests', method: 'GET', url: '/admin/password-reset-requests', query: [{ key: 'status', value: 'pending' }] }),
  req({ name: 'Update Password Reset Request', method: 'PATCH', url: '/admin/password-reset-requests', body: { id: '', status: 'approved', notes: '', approved_by: '', temp_password: '' } }),
  req({ name: 'Delete Password Reset Request', method: 'DELETE', url: '/admin/password-reset-requests', query: [{ key: 'id', value: '' }] }),
  req({ name: 'List Joining Codes', method: 'GET', url: '/admin/joining-codes', query: [{ key: 'schoolId', value: '' }] }),
  req({ name: 'Create Joining Code', method: 'POST', url: '/admin/joining-codes', body: {} }),
  req({ name: 'Update Joining Code', method: 'PATCH', url: '/admin/joining-codes', body: {} }),
  req({ name: 'List Leaves', method: 'GET', url: '/admin/leaves', query: [{ key: 'school_id', value: '' }] }),
  req({ name: 'Update Leave', method: 'PUT', url: '/admin/leaves', body: { id: '', status: 'approved', admin_remarks: '', approved_by: '' } }),
  req({ name: 'List Licenses', method: 'GET', url: '/admin/licenses', query: [{ key: 'schoolId', value: '' }] }),
  req({ name: 'Create License', method: 'POST', url: '/admin/licenses', body: {} }),
  req({ name: 'Import Licenses', method: 'POST', url: '/admin/licenses/import', body: {} }),
  req({ name: 'Decode License', method: 'POST', url: '/admin/licenses/decode', body: { activationKey: '' } }),
  req({ name: 'Update License', method: 'PATCH', url: '/admin/licenses/:id', body: {} }),
  req({ name: 'Delete License', method: 'DELETE', url: '/admin/licenses/:id' }),
  req({ name: 'Get Admin Profile', method: 'GET', url: '/admin/profile', query: [{ key: 'user_id', value: '' }] }),
  req({ name: 'Update Admin Profile', method: 'PATCH', url: '/admin/profile', body: {} }),
  req({ name: 'List Saved Views', method: 'GET', url: '/admin/saved-views', query: [{ key: 'table_key', value: 'students' }] }),
  req({ name: 'Create Saved View', method: 'POST', url: '/admin/saved-views', body: { table_key: 'students', name: '', state: {}, is_default: false } }),
  req({ name: 'Delete Saved View', method: 'DELETE', url: '/admin/saved-views/:id' }),
  req({
    name: 'Create Account (Admin)',
    method: 'POST',
    url: '/admin/create-account',
    description:
      'Requires an existing admin\'s Bearer token (run Auth > Login as an admin first). Use role: "admin" to create another admin — set is_super_admin: true for unrestricted cross-school access, false for a scoped admin. Use role: "school_admin"/"teacher"/"student" with tenantId/school_id for other account types.',
    body: { email: 'newadmin@yugminds.com', password: 'ChangeMe123!', role: 'admin', is_super_admin: false, tenantId: '' },
  }),
  req({ name: 'List Contact Submissions', method: 'GET', url: '/admin/contact-submissions', query: [{ key: 'status', value: 'new' }] }),
  req({ name: 'Update Contact Submission', method: 'PATCH', url: '/admin/contact-submissions/:id', body: { status: 'read', admin_notes: '' } }),
  req({ name: 'Delete Contact Submission', method: 'DELETE', url: '/admin/contact-submissions/:id' }),
  req({ name: 'Get Student Progress (Admin)', method: 'GET', url: '/admin/student-progress', query: [{ key: 'school_id', value: '' }] }),
]);

const adminCommunity = folder('Admin - Community CMS', [
  req({ name: 'Get Community Config', method: 'GET', url: '/admin/community/config' }),
  req({
    name: 'Update Community Config',
    method: 'PUT',
    url: '/admin/community/config',
    isFile: true,
    body: [
      { key: 'hero_title', type: 'text', value: '' },
      { key: 'hero_subtitle', type: 'text', value: '' },
      { key: 'section_titles', type: 'text', value: '{}' },
      { key: 'section_enabled', type: 'text', value: '{}' },
      { key: 'section_colors', type: 'text', value: '{}' },
      { key: 'impact_stats', type: 'text', value: '[]' },
      { key: 'social_links', type: 'text', value: '{}' },
      { key: 'corner_pillars', type: 'text', value: '[]' },
      { key: 'hero_image', type: 'file' },
    ],
  }),
  req({ name: 'List Community Items', method: 'GET', url: '/admin/community/items', query: [{ key: 'type', value: '' }, { key: 'published', value: '' }] }),
  req({ name: 'Get Community Item', method: 'GET', url: '/admin/community/items/:id' }),
  req({
    name: 'Create Community Item',
    method: 'POST',
    url: '/admin/community/items',
    isFile: true,
    body: [
      { key: 'section_type', type: 'text', value: '' },
      { key: 'title', type: 'text', value: '' },
      { key: 'subtitle', type: 'text', value: '' },
      { key: 'description', type: 'text', value: '' },
      { key: 'is_published', type: 'text', value: 'false' },
      { key: 'is_featured', type: 'text', value: 'false' },
      { key: 'media', type: 'file' },
    ],
  }),
  req({
    name: 'Update Community Item',
    method: 'PUT',
    url: '/admin/community/items/:id',
    isFile: true,
    body: [
      { key: 'title', type: 'text', value: '' },
      { key: 'media', type: 'file' },
    ],
  }),
  req({ name: 'Upload Item Thumbnail', method: 'POST', url: '/admin/community/items/:id/thumbnail', isFile: true, body: [{ key: 'thumbnail', type: 'file' }] }),
  req({ name: 'Upload Item Avatar', method: 'POST', url: '/admin/community/items/:id/avatar', isFile: true, body: [{ key: 'avatar', type: 'file' }] }),
  req({ name: 'Delete Community Item', method: 'DELETE', url: '/admin/community/items/:id' }),
  req({ name: 'Community Item Versions', method: 'GET', url: '/admin/community/items/:id/versions' }),
  req({ name: 'Revert Community Item', method: 'POST', url: '/admin/community/items/:id/revert', body: { version_id: '' } }),
]);

// ---- SCHOOL ADMIN -----------------------------------------------------------

const schoolAdminFolder = folder('School Admin', [
  req({ name: 'My School', method: 'GET', url: '/school-admin/school' }),
  req({ name: 'Stats', method: 'GET', url: '/school-admin/stats' }),
  req({ name: 'Assignment Analytics', method: 'GET', url: '/school-admin/assignment-analytics' }),
  req({ name: 'Leaderboard', method: 'GET', url: '/school-admin/leaderboard' }),
  req({ name: 'Get Profile', method: 'GET', url: '/school-admin/profile' }),
  req({ name: 'Update Profile', method: 'PATCH', url: '/school-admin/profile', body: { full_name: '', phone: '' } }),

  req({ name: 'Calendar - List', method: 'GET', url: '/school-admin/calendar', query: [{ key: 'year', value: '' }, { key: 'month', value: '' }] }),
  req({ name: 'Calendar - Create', method: 'POST', url: '/school-admin/calendar', body: { date: '', end_date: '', name: '', type: 'holiday', academic_year: '', description: '' } }),
  req({ name: 'Calendar - Update', method: 'PATCH', url: '/school-admin/calendar/:id', body: { name: '' } }),
  req({ name: 'Calendar - Delete', method: 'DELETE', url: '/school-admin/calendar/:id' }),

  req({ name: 'Rooms - List', method: 'GET', url: '/school-admin/rooms' }),
  req({ name: 'Rooms - Get', method: 'GET', url: '/school-admin/rooms/:id' }),
  req({ name: 'Rooms - Create', method: 'POST', url: '/school-admin/rooms', body: { room_number: '', room_name: '', capacity: 30, location: '', facilities: [], is_active: true } }),
  req({ name: 'Rooms - Update', method: 'PATCH', url: '/school-admin/rooms/:id', body: { room_name: '' } }),
  req({ name: 'Rooms - Delete', method: 'DELETE', url: '/school-admin/rooms/:id' }),

  req({ name: 'Periods - List', method: 'GET', url: '/school-admin/periods' }),
  req({ name: 'Periods - Get', method: 'GET', url: '/school-admin/periods/:id' }),
  req({ name: 'Periods - Create', method: 'POST', url: '/school-admin/periods', body: { period_number: 1, start_time: '09:00', end_time: '09:45', is_active: true } }),
  req({ name: 'Periods - Update', method: 'PATCH', url: '/school-admin/periods/:id', body: {} }),
  req({ name: 'Periods - Delete', method: 'DELETE', url: '/school-admin/periods/:id' }),

  req({ name: 'Teachers - List', method: 'GET', url: '/school-admin/teachers', query: [{ key: 'limit', value: '50' }] }),

  req({ name: 'Students - List', method: 'GET', url: '/school-admin/students', query: [{ key: 'limit', value: '50' }, { key: 'page', value: '1' }] }),
  req({
    name: 'Students - Create',
    method: 'POST',
    url: '/school-admin/students',
    body: { email: 'student@example.com', password: 'ChangeMe123!', full_name: '', parent_name: '', parent_phone: '', grade: '', section: '', joining_code: '' },
  }),
  req({
    name: 'Students - Bulk Import',
    method: 'POST',
    url: '/school-admin/students/bulk-import',
    body: { students: [{ email: '', password: '', full_name: '', parent_name: '', parent_phone: '', grade: '', section: '', joining_code: '', is_active: true }], dry_run: true },
  }),
  req({ name: 'Students - Update', method: 'PATCH', url: '/school-admin/students/:studentId', body: { full_name: '' } }),
  req({ name: 'Students - Set Password', method: 'PATCH', url: '/school-admin/students/:studentId/password', body: { password: 'NewPassword123!' } }),
  req({ name: 'Students - Delete', method: 'DELETE', url: '/school-admin/students/:studentId', query: [{ key: 'hard', value: 'false' }] }),
  req({ name: 'Students - Progress', method: 'GET', url: '/school-admin/student-progress', query: [{ key: 'course_id', value: '' }] }),

  req({ name: 'Courses - List', method: 'GET', url: '/school-admin/courses', query: [{ key: 'status', value: '' }] }),
  req({ name: 'Courses - Progress', method: 'GET', url: '/school-admin/courses/progress' }),
  req({ name: 'Courses - Progress by Course (Students)', method: 'GET', url: '/school-admin/courses/progress/students', query: [{ key: 'courseId', value: '' }] }),
  req({ name: 'Courses - Progress Detail', method: 'GET', url: '/school-admin/courses/progress/students/detail', query: [{ key: 'courseId', value: '' }, { key: 'studentId', value: '' }] }),

  req({ name: 'Schedules - List', method: 'GET', url: '/school-admin/schedules' }),
  req({ name: 'Schedules - Get', method: 'GET', url: '/school-admin/schedules/:id' }),
  req({
    name: 'Schedules - Create',
    method: 'POST',
    url: '/school-admin/schedules',
    body: { class_id: '', teacher_id: '', subject: '', grade: '', day_of_week: 1, period_id: '', room_id: '', start_time: '', end_time: '', academic_year: '', notes: '', is_active: true },
  }),
  req({ name: 'Schedules - Update', method: 'PATCH', url: '/school-admin/schedules/:id', body: {} }),
  req({ name: 'Schedules - Delete', method: 'DELETE', url: '/school-admin/schedules/:id' }),
  req({ name: 'Schedules - Sync to Teachers', method: 'POST', url: '/school-admin/schedules/sync-to-teachers', body: { teacherIds: [] } }),

  req({ name: 'Notifications - List', method: 'GET', url: '/school-admin/notifications', query: [{ key: 'limit', value: '20' }] }),
  req({ name: 'Notifications - Send', method: 'POST', url: '/school-admin/notifications', body: { title: '', message: '', type: 'info', recipientType: 'all', recipients: [], school_id: '', allowReplies: true } }),
  req({ name: 'Notifications - Recipients', method: 'GET', url: '/school-admin/notifications/recipients', query: [{ key: 'school_id', value: '' }] }),
  req({ name: 'Notifications - Update', method: 'PATCH', url: '/school-admin/notifications/:id', body: { is_read: true, deleted: false } }),

  req({ name: 'Reports - List', method: 'GET', url: '/school-admin/reports', query: [{ key: 'pending', value: 'true' }] }),
  req({ name: 'Reports - Get', method: 'GET', url: '/school-admin/reports/:id' }),
  req({ name: 'Reports - Bulk Update', method: 'PATCH', url: '/school-admin/reports/bulk', body: { report_ids: [], action: 'approve' } }),
  req({ name: 'Reports - Update', method: 'PATCH', url: '/school-admin/reports/:id', body: { action: 'approve', status: 'reviewed' } }),

  req({ name: 'Leaves - List', method: 'GET', url: '/school-admin/leaves', query: [{ key: 'status', value: '' }] }),
  req({ name: 'Leaves - Get', method: 'GET', url: '/school-admin/leaves/:id' }),
  req({ name: 'Leaves - Update', method: 'PATCH', url: '/school-admin/leaves/:id', body: { action: 'approve', status: 'approved', admin_remarks: '' } }),

  req({ name: 'Password Resets - List', method: 'GET', url: '/school-admin/password-reset-requests', query: [{ key: 'status', value: 'pending' }] }),
  req({ name: 'Password Resets - Update', method: 'PATCH', url: '/school-admin/password-reset-requests', body: { id: '', status: 'approved', notes: '', approved_by: '', temp_password: '' } }),
  req({ name: 'Password Resets - Delete', method: 'DELETE', url: '/school-admin/password-reset-requests', query: [{ key: 'id', value: '' }] }),

  req({ name: 'Data - Export', method: 'GET', url: '/school-admin/data/export' }),
  req({
    name: 'Data - Import',
    method: 'POST',
    url: '/school-admin/data/import',
    body: { type: 'students', records: [{ email: '', password: '', full_name: '', parent_name: '', parent_phone: '', grade: '', section: '' }] },
  }),
]);

// ---- TEACHER ------------------------------------------------------------

const teacherFolder = folder('Teacher', [
  req({ name: 'Dashboard', method: 'GET', url: '/teacher/dashboard', query: [{ key: 'school_id', value: '' }] }),
  req({ name: 'My Schools', method: 'GET', url: '/teacher/schools' }),
  req({ name: 'Classes', method: 'GET', url: '/teacher/classes', query: [{ key: 'school_id', value: '' }] }),
  req({ name: 'Periods', method: 'GET', url: '/teacher/periods', query: [{ key: 'school_id', value: '' }, { key: 'day', value: '' }] }),
  req({ name: 'Schedules', method: 'GET', url: '/teacher/schedules', query: [{ key: 'school_id', value: '' }, { key: 'day', value: '' }] }),
  req({ name: 'Analytics', method: 'GET', url: '/teacher/analytics', query: [{ key: 'school_id', value: '' }] }),
  req({ name: 'Assignment Analytics', method: 'GET', url: '/teacher/assignment-analytics' }),
  req({ name: 'Student Progress', method: 'GET', url: '/teacher/student-progress', query: [{ key: 'school_id', value: '' }] }),

  req({ name: 'Attendance - Today', method: 'GET', url: '/teacher/attendance/today', query: [{ key: 'school_id', value: '' }] }),
  req({ name: 'Attendance - Monthly', method: 'GET', url: '/teacher/attendance/monthly', query: [{ key: 'school_id', value: '' }, { key: 'yearMonth', value: '' }] }),
  req({ name: 'Attendance - Range', method: 'GET', url: '/teacher/attendance', query: [{ key: 'school_id', value: '' }, { key: 'from', value: '' }, { key: 'to', value: '' }] }),

  req({ name: 'Leaves - Apply', method: 'POST', url: '/teacher/leaves', body: { school_id: '', start_date: '', end_date: '', reason: '', substitute_required: false } }),
  req({ name: 'Leaves - List', method: 'GET', url: '/teacher/leaves', query: [{ key: 'school_id', value: '' }] }),

  req({
    name: 'Reports - Submit',
    method: 'POST',
    url: '/teacher/reports',
    body: { school_id: '', grade: '', date: '', period_id: '', start_time: '', end_time: '', topics_taught: '', activities: '', notes: '' },
  }),
  req({ name: 'Reports - List', method: 'GET', url: '/teacher/reports', query: [{ key: 'school_id', value: '' }, { key: 'limit', value: '20' }] }),

  req({ name: 'Notifications - List', method: 'GET', url: '/teacher/notifications', query: [{ key: 'limit', value: '20' }] }),
  req({ name: 'Notifications - Send', method: 'POST', url: '/teacher/notifications', body: { title: '', message: '', type: 'info', school_id: '', recipientType: 'all', recipients: [], allowReplies: true } }),
  req({ name: 'Notifications - Recipients', method: 'GET', url: '/teacher/notifications/recipients', query: [{ key: 'school_id', value: '' }] }),
  req({ name: 'Notifications - Get', method: 'GET', url: '/teacher/notifications/:id' }),
  req({ name: 'Notifications - Update', method: 'PATCH', url: '/teacher/notifications/:id', body: { is_read: true, deleted: false } }),

  req({ name: 'Assignments - List', method: 'GET', url: '/teacher/assignments', query: [{ key: 'school_id', value: '' }, { key: 'type', value: '' }] }),
  req({
    name: 'Assignments - Create',
    method: 'POST',
    url: '/teacher/assignments',
    body: {
      title: '', schoolId: '', assignmentType: 'DAILY', courseId: '', gradeId: '', subject: '', dueDate: '',
      totalMarks: 100, isPublished: false, publishScope: 'grade', publishedGradeIds: [], publishedSectionIds: [],
      retakeEnabled: false, maxRetakeAttempts: 1, retakeScoringRule: 'latest', questions: [],
    },
  }),
  req({ name: 'Assignments - Get', method: 'GET', url: '/teacher/assignments/:assignmentId' }),
  req({ name: 'Assignments - Update', method: 'PATCH', url: '/teacher/assignments/:assignmentId', body: { title: '', questions: [] } }),
  req({ name: 'Assignments - Delete', method: 'DELETE', url: '/teacher/assignments/:assignmentId' }),
  req({
    name: 'Assignments - Retake Settings',
    method: 'PATCH',
    url: '/teacher/assignments/:assignmentId/retake-settings',
    body: { retakeEnabled: true, maxRetakeAttempts: 1, retakeScoringRule: 'latest', retakeWindowOpen: true, retakeAccessScope: 'all' },
  }),
  req({ name: 'Assignments - Grant Retakes', method: 'POST', url: '/teacher/assignments/:assignmentId/retake-grants', body: { studentIds: [], isActive: true } }),
  req({ name: 'Assignments - Open Retake for All', method: 'POST', url: '/teacher/assignments/:assignmentId/retake-open-all', body: { gradeId: '' } }),
  req({ name: 'Assignments - Close Retake', method: 'POST', url: '/teacher/assignments/:assignmentId/retake-close' }),
  req({ name: 'Assignments - Batch Grade', method: 'POST', url: '/teacher/assignments/batch-grade', body: { grades: [{ submissionId: '', assignmentId: '', score: 0, feedback: '' }] } }),
  req({ name: 'Assignments - Submissions', method: 'GET', url: '/teacher/assignments/:assignmentId/submissions' }),
  req({ name: 'Assignments - Grade Submission', method: 'PATCH', url: '/teacher/assignments/:assignmentId/submissions/:submissionId/grade', body: { score: 0, feedback: '', status: 'graded' } }),
  req({ name: 'Assignments - Attempt History', method: 'GET', url: '/teacher/assignments/:assignmentId/attempt-history/:studentId' }),
  req({ name: 'Assignments - Progress Dashboard', method: 'GET', url: '/teacher/assignments/:assignmentId/progress-dashboard' }),
]);

// ---- STUDENT --------------------------------------------------------------

const studentFolder = folder('Student', [
  req({ name: 'Dashboard', method: 'GET', url: '/student/dashboard' }),
  req({ name: 'Certificates - List', method: 'GET', url: '/student/certificates' }),
  req({ name: 'Certificates - Generate', method: 'POST', url: '/student/certificates/generate', body: { courseId: '' } }),
  req({
    name: 'Assignments - Upload File',
    method: 'POST',
    url: '/student/assignments/upload',
    isFile: true,
    body: [{ key: 'file', type: 'file' }],
  }),
  req({ name: 'Courses - List', method: 'GET', url: '/student/courses' }),
  req({ name: 'Courses - Chapters', method: 'GET', url: '/student/courses/:courseId/chapters' }),
  req({ name: 'Courses - Chapter Contents', method: 'GET', url: '/student/courses/:courseId/chapters/:chapterId/contents' }),
  req({ name: 'Assignments - List', method: 'GET', url: '/student/assignments' }),
  req({ name: 'Assignments - Hierarchy', method: 'GET', url: '/student/assignments/hierarchy' }),
  req({ name: 'Assignments - Get', method: 'GET', url: '/student/assignments/:assignmentId' }),
  req({ name: 'Assignments - Submit', method: 'POST', url: '/student/assignments/:assignmentId/submit', body: { answers: {}, fileUrl: '', textContent: '' } }),
  req({ name: 'Progress - Get', method: 'GET', url: '/student/progress', query: [{ key: 'course_id', value: '' }] }),
  req({ name: 'Simple Progress - Get', method: 'GET', url: '/student/simple-progress', query: [{ key: 'courseId', value: '' }, { key: 'chapterId', value: '' }] }),
  req({ name: 'Simple Progress - Set', method: 'POST', url: '/student/simple-progress', body: { courseId: '', chapterId: '', contentId: '', isCompleted: true } }),
  req({ name: 'Save Chapter Progress', method: 'POST', url: '/student/save-chapter-progress', body: { courseId: '', chapterId: '', progress: 0, completed: false } }),
  req({ name: 'Last Viewed - Set', method: 'POST', url: '/student/last-viewed', body: { courseId: '', chapterId: '', contentId: '' } }),
  req({ name: 'Last Viewed - Get', method: 'GET', url: '/student/last-viewed' }),
  req({ name: 'Activity', method: 'GET', url: '/student/activity' }),
  req({ name: 'Analytics', method: 'GET', url: '/student/analytics' }),
  req({ name: 'Notifications - Send', method: 'POST', url: '/student/notifications', body: { title: '', message: '', school_id: '', recipientType: 'all', recipients: [] } }),
  req({ name: 'Notifications - Recipients', method: 'GET', url: '/student/notifications/recipients', query: [{ key: 'school_id', value: '' }] }),
]);

// ---- assemble collection ---------------------------------------------------

const collection = {
  info: {
    _postman_id: uuid(),
    name: 'Yugminds Backend API',
    description:
      'Auto-generated from the NestJS controller inventory. Set `baseUrl` (default http://localhost:3001) and run "Auth > Login" first — it saves the access token into the `accessToken` collection variable used by every other request. Enable Postman\'s cookie jar for `{{baseUrl}}` so `/auth/refresh` and `/auth/logout` pick up the httpOnly `refresh_token` cookie set by Login.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: {
    type: 'bearer',
    bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }],
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3001', type: 'string' },
    { key: 'accessToken', value: '', type: 'string' },
  ],
  item: [
    authFolder,
    publicFolder,
    commonFolder,
    adminCore,
    adminSchools,
    adminStudents,
    adminTeachers,
    adminSchoolAdmins,
    adminCourses,
    adminCertificates,
    adminSettingsSecurity,
    adminMisc,
    adminCommunity,
    schoolAdminFolder,
    teacherFolder,
    studentFolder,
  ],
};

// Auto-register every {{pathParam}} used anywhere as a blank collection
// variable, so Postman's variable editor shows/lets you fill them all in
// one place instead of leaving undeclared placeholders.
function collectPathVars(items, set) {
  for (const it of items) {
    if (it.request?.url?.path) {
      for (const seg of it.request.url.path) {
        const m = /^\{\{(.+)\}\}$/.exec(seg);
        if (m && m[1] !== 'baseUrl') set.add(m[1]);
      }
    }
    if (it.item) collectPathVars(it.item, set);
  }
}
const pathVars = new Set();
collectPathVars(collection.item, pathVars);
for (const v of [...pathVars].sort()) {
  collection.variable.push({ key: v, value: '', type: 'string' });
}

const outPath = path.join(__dirname, 'Yugminds-Backend.postman_collection.json');
fs.writeFileSync(outPath, JSON.stringify(collection, null, 2) + '\n');

// sanity: count requests
function countRequests(items) {
  let n = 0;
  for (const it of items) {
    if (it.request) n++;
    if (it.item) n += countRequests(it.item);
  }
  return n;
}
console.log('Wrote', outPath);
console.log('Total requests:', countRequests(collection.item));
console.log('Total folders:', collection.item.length);
console.log('Path variables registered:', [...pathVars].sort().join(', '));
