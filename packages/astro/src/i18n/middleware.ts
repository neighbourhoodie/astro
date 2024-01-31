import { appendForwardSlash, joinPaths } from '@astrojs/internal-helpers/path';
import type { Locales, MiddlewareHandler, RouteData, SSRManifest } from '../@types/astro.js';
import type { PipelineHookFunction } from '../core/pipeline.js';
import { getPathByLocale, normalizeTheLocale } from './index.js';
import { shouldAppendForwardSlash } from '../core/build/util.js';
import { ROUTE_DATA_SYMBOL } from '../core/constants.js';

const routeDataSymbol = Symbol.for(ROUTE_DATA_SYMBOL);

// Checks if the pathname has any locale, exception for the defaultLocale, which is ignored on purpose.
function pathnameHasLocale(pathname: string, locales: Locales): boolean {
	const segments = pathname.split('/');
	for (const segment of segments) {
		for (const locale of locales) {
			if (typeof locale === 'string') {
				if (normalizeTheLocale(segment) === normalizeTheLocale(locale)) {
					return true;
				}
			} else if (segment === locale.path) {
				return true;
			}
		}
	}

	return false;
}

export function createI18nMiddleware(
	i18n: SSRManifest['i18n'],
	base: SSRManifest['base'],
	trailingSlash: SSRManifest['trailingSlash'],
	buildFormat: SSRManifest['buildFormat']
): MiddlewareHandler {
	if (!i18n) return (_, next) => next();

	return async (context, next) => {
		const routeData: RouteData | undefined = Reflect.get(context.request, routeDataSymbol);
		// If the route we're processing is not a page, then we ignore it
		if (routeData?.type !== 'page' && routeData?.type !== 'fallback') {
			return await next();
		}

		const url = context.url;
		const { locales, defaultLocale, fallback, routing } = i18n;
		const response = await next();

		if (response instanceof Response) {
			// We want to detect the default locale only when it is followed
			// by `/` or nothing, not when it is part of a URL fragment, eg.
			// `/de/crypto/enigma` should not match if the default locale is `en`.
			const regex = new RegExp(`/${defaultLocale}(/|$)`, 'g')
			const pathnameContainsDefaultLocale = !!url.pathname.match(regex)
			switch (i18n.routing) {
				case 'pathname-prefix-other-locales': {
					if (pathnameContainsDefaultLocale) {
						// We want to remove the default locale only when it is followed
						// by `/` or nothing, not when it is part of a URL fragment, eg. 
						// `/en/crypto/enigma` should not become 
						// `/cryptoigma` if the default locale of `en` is stripped
						const newLocation = url.pathname.replace(regex, '$1')
						response.headers.set('Location', newLocation);
						return new Response(null, {
							status: 404,
							headers: response.headers,
						});
					}
					break;
				}

				case 'pathname-prefix-always-no-redirect': {
					// We return a 404 if:
					// - the current path isn't a root. e.g. / or /<base>
					// - the URL doesn't contain a locale
					const isRoot = url.pathname === base + '/' || url.pathname === base;
					if (!(isRoot || pathnameHasLocale(url.pathname, i18n.locales))) {
						return new Response(null, {
							status: 404,
							headers: response.headers,
						});
					}
					break;
				}

				case 'pathname-prefix-always': {
					if (url.pathname === base + '/' || url.pathname === base) {
						if (shouldAppendForwardSlash(trailingSlash, buildFormat)) {
							return context.redirect(`${appendForwardSlash(joinPaths(base, i18n.defaultLocale))}`);
						} else {
							return context.redirect(`${joinPaths(base, i18n.defaultLocale)}`);
						}
					}

					// Astro can't know where the default locale is supposed to be, so it returns a 404 with no content.
					else if (!pathnameHasLocale(url.pathname, i18n.locales)) {
						return new Response(null, {
							status: 404,
							headers: response.headers,
						});
					}
				}
			}

			if (response.status >= 300 && fallback) {
				const fallbackKeys = i18n.fallback ? Object.keys(i18n.fallback) : [];

				// we split the URL using the `/`, and then check in the returned array we have the locale
				const segments = url.pathname.split('/');
				const urlLocale = segments.find((segment) => {
					for (const locale of locales) {
						if (typeof locale === 'string') {
							if (locale === segment) {
								return true;
							}
						} else if (locale.path === segment) {
							return true;
						}
					}
					return false;
				});

				if (urlLocale && fallbackKeys.includes(urlLocale)) {
					const fallbackLocale = fallback[urlLocale];
					// the user might have configured the locale using the granular locales, so we want to retrieve its corresponding path instead
					const pathFallbackLocale = getPathByLocale(fallbackLocale, locales);
					let newPathname: string;
					// If a locale falls back to the default locale, we want to **remove** the locale because
					// the default locale doesn't have a prefix
					if (pathFallbackLocale === defaultLocale && routing === 'pathname-prefix-other-locales') {
						newPathname = url.pathname.replace(`/${urlLocale}`, ``);
					} else {
						newPathname = url.pathname.replace(`/${urlLocale}`, `/${pathFallbackLocale}`);
					}

					return context.redirect(newPathname);
				}
			}
		}

		return response;
	};
}

/**
 * This pipeline hook attaches a `RouteData` object to the `Request`
 */
export const i18nPipelineHook: PipelineHookFunction = (ctx) => {
	Reflect.set(ctx.request, routeDataSymbol, ctx.route);
};
