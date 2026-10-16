/**
 * Contract fixtures copied field-for-field from the eWings source (read-only, never modified):
 *  - main site: public/api/send_email.php (json_encode before the cURL to LEAD_API_URL)
 *  - blog:      blog/src/server/leads.service.ts (fetch body to LEAD_API_URL)
 * All values are TEST DATA (fictional people, example.test emails).
 */
export const EWINGS_MAIN_SITE = {
  name: 'Test Student',
  mobile: '9876543210',
  email: 'student@example.test',
  message: 'Need details for MBBS abroad',
  parent_student: 'Parent',
  education: 'Intermediate',
  group: 'BiPC',
  neet_status: 'Qualified',
  neet_score: 512,
  preferred_country: 'Kyrgyzstan',
  google_click_id: 'Cj0KCQ-test',
  campaign_id: '123456789',
  source: 'Landing Page',
};

/** JSON.stringify drops `undefined`, exactly as the blog's fetch() body does. */
export const EWINGS_BLOG = {
  name: 'Blog Reader',
  phone: '+91 98765 43211',
  email: undefined,
  city: 'Guntur',
  neetScore: '498',
  source: 'blog_inline_cta',
  postSlug: 'mbbs-in-georgia-fees',
};

/** The Authorization header both senders produce: Basic base64(user:pass). */
export function basicAuth(username: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64');
}
