// JSON-LD structured data per route. The FAQ entries are built from the same
// arrays the pages render (content.ts), so the visible copy and the
// structured data can never drift apart.

import { FAQ, PRICING_FAQ } from '../pages/public/content'
import { pageMeta, site } from './pageMeta'

const HTML_TAG = /<[^>]*>/g

/** FAQ answers are plain copy today, but strip any HTML just in case before it lands in JSON-LD. */
function plainText(value: string): string {
  return value.replace(HTML_TAG, '').trim()
}

function faqPage(faq: Array<{ q: string; a: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: plainText(f.q),
      acceptedAnswer: { '@type': 'Answer', text: plainText(f.a) },
    })),
  }
}

function breadcrumbs(path: string, name: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: site.origin },
      { '@type': 'ListItem', position: 2, name, item: `${site.origin}${path}` },
    ],
  }
}

function softwareApplication(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: site.name,
    url: site.origin,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, Web',
    description: pageMeta('/').description,
    publisher: {
      '@type': 'Organization',
      name: 'TynHub',
      url: 'https://tynhub.com',
    },
    offers: [
      { '@type': 'Offer', name: 'Self-hosted', price: '0', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Hosted alpha', price: '0', priceCurrency: 'USD' },
    ],
  }
}

/** JSON-LD objects to embed for `path`, or [] for routes with none (sign-in, account pages, 404). */
export function jsonLdForRoute(path: string): Array<Record<string, unknown>> {
  switch (path) {
    case '/':
      return [softwareApplication(), faqPage(FAQ)]
    case '/pricing':
      return [breadcrumbs(path, pageMeta(path).title), faqPage(PRICING_FAQ)]
    case '/how-it-works':
    case '/privacy':
    case '/terms':
      return [breadcrumbs(path, pageMeta(path).title)]
    default:
      return []
  }
}
