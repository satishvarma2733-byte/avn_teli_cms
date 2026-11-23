import type { MetadataRoute } from 'next';

/**
 * aVn CMS is a private, signed-in application: nothing in it is meant for search engines. Every page
 * also carries `robots: noindex` (see layout.tsx); this file says the same to crawlers before they ask.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
