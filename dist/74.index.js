"use strict";
exports.id = 74;
exports.ids = [74];
exports.modules = {

/***/ 12203:
/***/ ((module) => {



/**
 * @typedef {Object} HttpRequest
 * @property {Record<string, string>} headers - Request headers
 * @property {string} [method] - HTTP method
 * @property {string} [url] - Request URL
 */

/**
 * @typedef {Object} HttpResponse
 * @property {Record<string, string>} headers - Response headers
 * @property {number} [status] - HTTP status code
 */

/**
 * Set of default cacheable status codes per RFC 7231 section 6.1.
 * @type {Set<number>}
 */
const statusCodeCacheableByDefault = new Set([
    200,
    203,
    204,
    206,
    300,
    301,
    308,
    404,
    405,
    410,
    414,
    501,
]);

/**
 * Set of HTTP status codes that the cache implementation understands.
 * Note: This implementation does not understand partial responses (206).
 * @type {Set<number>}
 */
const understoodStatuses = new Set([
    200,
    203,
    204,
    300,
    301,
    302,
    303,
    307,
    308,
    404,
    405,
    410,
    414,
    501,
]);

/**
 * Set of HTTP error status codes.
 * @type {Set<number>}
 */
const errorStatusCodes = new Set([
    500,
    502,
    503,
    504,
]);

/**
 * Object representing hop-by-hop headers that should be removed.
 * @type {Record<string, boolean>}
 */
const hopByHopHeaders = {
    date: true, // included, because we add Age update Date
    connection: true,
    'keep-alive': true,
    'proxy-authenticate': true,
    'proxy-authorization': true,
    te: true,
    trailer: true,
    'transfer-encoding': true,
    upgrade: true,
};

/**
 * Headers that are excluded from revalidation update.
 * @type {Record<string, boolean>}
 */
const excludedFromRevalidationUpdate = {
    // Since the old body is reused, it doesn't make sense to change properties of the body
    'content-length': true,
    'content-encoding': true,
    'transfer-encoding': true,
    'content-range': true,
};

/**
 * Converts a string to a number or returns zero if the conversion fails.
 * @param {string} s - The string to convert.
 * @returns {number} The parsed number or 0.
 */
function toNumberOrZero(s) {
    const n = parseInt(s, 10);
    return isFinite(n) ? n : 0;
}

/**
 * Determines if the given response is an error response.
 * Implements RFC 5861 behavior.
 * @param {HttpResponse|undefined} response - The HTTP response object.
 * @returns {boolean} true if the response is an error or undefined, false otherwise.
 */
function isErrorResponse(response) {
    // consider undefined response as faulty
    if (!response) {
        return true;
    }
    return errorStatusCodes.has(response.status);
}

/**
 * Parses a Cache-Control header string into an object.
 * @param {string} [header] - The Cache-Control header value.
 * @returns {Record<string, string|boolean>} An object representing Cache-Control directives.
 */
function parseCacheControl(header) {
    /** @type {Record<string, string|boolean>} */
    const cc = {};
    if (!header) return cc;

    // TODO: When there is more than one value present for a given directive (e.g., two Expires header fields, multiple Cache-Control: max-age directives),
    // the directive's value is considered invalid. Caches are encouraged to consider responses that have invalid freshness information to be stale
    const parts = header.trim().split(/,/);
    for (const part of parts) {
        const [k, v] = part.split(/=/, 2);
        cc[k.trim()] = v === undefined ? true : v.trim().replace(/^"|"$/g, '');
    }

    return cc;
}

/**
 * Formats a Cache-Control directives object into a header string.
 * @param {Record<string, string|boolean>} cc - The Cache-Control directives.
 * @returns {string|undefined} A formatted Cache-Control header string or undefined if empty.
 */
function formatCacheControl(cc) {
    let parts = [];
    for (const k in cc) {
        const v = cc[k];
        parts.push(v === true ? k : k + '=' + v);
    }
    if (!parts.length) {
        return undefined;
    }
    return parts.join(', ');
}

module.exports = class CachePolicy {
    /**
     * Creates a new CachePolicy instance.
     * @param {HttpRequest} req - Incoming client request.
     * @param {HttpResponse} res - Received server response.
     * @param {Object} [options={}] - Configuration options.
     * @param {boolean} [options.shared=true] - Is the cache shared (a public proxy)? `false` for personal browser caches.
     * @param {number} [options.cacheHeuristic=0.1] - Fallback heuristic (age fraction) for cache duration.
     * @param {number} [options.immutableMinTimeToLive=86400000] - Minimum TTL for immutable responses in milliseconds.
     * @param {boolean} [options.ignoreCargoCult=false] - Detect nonsense cache headers, and override them.
     * @param {any} [options._fromObject] - Internal parameter for deserialization. Do not use.
     */
    constructor(
        req,
        res,
        {
            shared,
            cacheHeuristic,
            immutableMinTimeToLive,
            ignoreCargoCult,
            _fromObject,
        } = {}
    ) {
        if (_fromObject) {
            this._fromObject(_fromObject);
            return;
        }

        if (!res || !res.headers) {
            throw Error('Response headers missing');
        }
        this._assertRequestHasHeaders(req);

        /** @type {number} Timestamp when the response was received */
        this._responseTime = this.now();
        /** @type {boolean} Indicates if the cache is shared */
        this._isShared = shared !== false;
        /** @type {boolean} Indicates if legacy cargo cult directives should be ignored */
        this._ignoreCargoCult = !!ignoreCargoCult;
        /** @type {number} Heuristic cache fraction */
        this._cacheHeuristic =
            undefined !== cacheHeuristic ? cacheHeuristic : 0.1; // 10% matches IE
        /** @type {number} Minimum TTL for immutable responses in ms */
        this._immutableMinTtl =
            undefined !== immutableMinTimeToLive
                ? immutableMinTimeToLive
                : 24 * 3600 * 1000;

        /** @type {number} HTTP status code */
        this._status = 'status' in res ? res.status : 200;
        /** @type {Record<string, string>} Response headers */
        this._resHeaders = res.headers;
        /** @type {Record<string, string|boolean>} Parsed Cache-Control directives from response */
        this._rescc = parseCacheControl(res.headers['cache-control']);
        /** @type {string} HTTP method (e.g., GET, POST) */
        this._method = 'method' in req ? req.method : 'GET';
        /** @type {string} Request URL */
        this._url = req.url;
        /** @type {string} Host header from the request */
        this._host = req.headers.host;
        /** @type {boolean} Whether the request does not include an Authorization header */
        this._noAuthorization = !req.headers.authorization;
        /** @type {Record<string, string>|null} Request headers used for Vary matching */
        this._reqHeaders = res.headers.vary ? req.headers : null; // Don't keep all request headers if they won't be used
        /** @type {Record<string, string|boolean>} Parsed Cache-Control directives from request */
        this._reqcc = parseCacheControl(req.headers['cache-control']);

        // Assume that if someone uses legacy, non-standard uncecessary options they don't understand caching,
        // so there's no point stricly adhering to the blindly copy&pasted directives.
        if (
            this._ignoreCargoCult &&
            'pre-check' in this._rescc &&
            'post-check' in this._rescc
        ) {
            delete this._rescc['pre-check'];
            delete this._rescc['post-check'];
            delete this._rescc['no-cache'];
            delete this._rescc['no-store'];
            delete this._rescc['must-revalidate'];
            this._resHeaders = Object.assign({}, this._resHeaders, {
                'cache-control': formatCacheControl(this._rescc),
            });
            delete this._resHeaders.expires;
            delete this._resHeaders.pragma;
        }

        // When the Cache-Control header field is not present in a request, caches MUST consider the no-cache request pragma-directive
        // as having the same effect as if "Cache-Control: no-cache" were present (see Section 5.2.1).
        if (
            res.headers['cache-control'] == null &&
            /no-cache/.test(res.headers.pragma)
        ) {
            this._rescc['no-cache'] = true;
        }
    }

    /**
     * You can monkey-patch it for testing.
     * @returns {number} Current time in milliseconds.
     */
    now() {
        return Date.now();
    }

    /**
     * Determines if the response is storable in a cache.
     * @returns {boolean} `false` if can never be cached.
     */
    storable() {
        // The "no-store" request directive indicates that a cache MUST NOT store any part of either this request or any response to it.
        return !!(
            !this._reqcc['no-store'] &&
            // A cache MUST NOT store a response to any request, unless:
            // The request method is understood by the cache and defined as being cacheable, and
            ('GET' === this._method ||
                'HEAD' === this._method ||
                ('POST' === this._method && this._hasExplicitExpiration())) &&
            // the response status code is understood by the cache, and
            understoodStatuses.has(this._status) &&
            // the "no-store" cache directive does not appear in request or response header fields, and
            !this._rescc['no-store'] &&
            // the "private" response directive does not appear in the response, if the cache is shared, and
            (!this._isShared || !this._rescc.private) &&
            // the Authorization header field does not appear in the request, if the cache is shared,
            (!this._isShared ||
                this._noAuthorization ||
                this._allowsStoringAuthenticated()) &&
            // the response either:
            // contains an Expires header field, or
            (this._resHeaders.expires ||
                // contains a max-age response directive, or
                // contains a s-maxage response directive and the cache is shared, or
                // contains a public response directive.
                this._rescc['max-age'] ||
                (this._isShared && this._rescc['s-maxage']) ||
                this._rescc.public ||
                // has a status code that is defined as cacheable by default
                statusCodeCacheableByDefault.has(this._status))
        );
    }

    /**
     * @returns {boolean} true if expiration is explicitly defined.
     */
    _hasExplicitExpiration() {
        // 4.2.1 Calculating Freshness Lifetime
        return !!(
            (this._isShared && this._rescc['s-maxage']) ||
            this._rescc['max-age'] ||
            this._resHeaders.expires
        );
    }

    /**
     * @param {HttpRequest} req - a request
     * @throws {Error} if the headers are missing.
     */
    _assertRequestHasHeaders(req) {
        if (!req || !req.headers) {
            throw Error('Request headers missing');
        }
    }

    /**
     * Checks if the request matches the cache and can be satisfied from the cache immediately,
     * without having to make a request to the server.
     *
     * This doesn't support `stale-while-revalidate`. See `evaluateRequest()` for a more complete solution.
     *
     * @param {HttpRequest} req - The new incoming HTTP request.
     * @returns {boolean} `true`` if the cached response used to construct this cache policy satisfies the request without revalidation.
     */
    satisfiesWithoutRevalidation(req) {
        const result = this.evaluateRequest(req);
        return !result.revalidation;
    }

    /**
     * @param {{headers: Record<string, string>, synchronous: boolean}|undefined} revalidation - Revalidation information, if any.
     * @returns {{response: {headers: Record<string, string>}, revalidation: {headers: Record<string, string>, synchronous: boolean}|undefined}} An object with a cached response headers and revalidation info.
     */
    _evaluateRequestHitResult(revalidation) {
        return {
            response: {
                headers: this.responseHeaders(),
            },
            revalidation,
        };
    }

    /**
     * @param {HttpRequest} request - new incoming
     * @param {boolean} synchronous - whether revalidation must be synchronous (not s-w-r).
     * @returns {{headers: Record<string, string>, synchronous: boolean}} An object with revalidation headers and a synchronous flag.
     */
    _evaluateRequestRevalidation(request, synchronous) {
        return {
            synchronous,
            headers: this.revalidationHeaders(request),
        };
    }

    /**
     * @param {HttpRequest} request - new incoming
     * @returns {{response: undefined, revalidation: {headers: Record<string, string>, synchronous: boolean}}} An object indicating no cached response and revalidation details.
     */
    _evaluateRequestMissResult(request) {
        return {
            response: undefined,
            revalidation: this._evaluateRequestRevalidation(request, true),
        };
    }

    /**
     * Checks if the given request matches this cache entry, and how the cache can be used to satisfy it. Returns an object with:
     *
     * ```
     * {
     *     // If defined, you must send a request to the server.
     *     revalidation: {
     *         headers: {}, // HTTP headers to use when sending the revalidation response
     *         // If true, you MUST wait for a response from the server before using the cache
     *         // If false, this is stale-while-revalidate. The cache is stale, but you can use it while you update it asynchronously.
     *         synchronous: bool,
     *     },
     *     // If defined, you can use this cached response.
     *     response: {
     *         headers: {}, // Updated cached HTTP headers you must use when responding to the client
     *     },
     * }
     * ```
     * @param {HttpRequest} req - new incoming HTTP request
     * @returns {{response: {headers: Record<string, string>}|undefined, revalidation: {headers: Record<string, string>, synchronous: boolean}|undefined}} An object containing keys:
     *   - revalidation: { headers: Record<string, string>, synchronous: boolean } Set if you should send this to the origin server
     *   - response: { headers: Record<string, string> } Set if you can respond to the client with these cached headers
     */
    evaluateRequest(req) {
        this._assertRequestHasHeaders(req);

        // In all circumstances, a cache MUST NOT ignore the must-revalidate directive
        if (this._rescc['must-revalidate']) {
            return this._evaluateRequestMissResult(req);
        }

        if (!this._requestMatches(req, false)) {
            return this._evaluateRequestMissResult(req);
        }

        // When presented with a request, a cache MUST NOT reuse a stored response, unless:
        // the presented request does not contain the no-cache pragma (Section 5.4), nor the no-cache cache directive,
        // unless the stored response is successfully validated (Section 4.3), and
        const requestCC = parseCacheControl(req.headers['cache-control']);

        if (requestCC['no-cache'] || /no-cache/.test(req.headers.pragma)) {
            return this._evaluateRequestMissResult(req);
        }

        if (requestCC['max-age'] && this.age() > toNumberOrZero(requestCC['max-age'])) {
            return this._evaluateRequestMissResult(req);
        }

        if (requestCC['min-fresh'] && this.maxAge() - this.age() < toNumberOrZero(requestCC['min-fresh'])) {
            return this._evaluateRequestMissResult(req);
        }

        // the stored response is either:
        // fresh, or allowed to be served stale
        if (this.stale()) {
            // If a value is present, then the client is willing to accept a response that has
            // exceeded its freshness lifetime by no more than the specified number of seconds
            const allowsStaleWithoutRevalidation = 'max-stale' in requestCC &&
                (true === requestCC['max-stale'] || requestCC['max-stale'] > this.age() - this.maxAge());

            if (allowsStaleWithoutRevalidation) {
                return this._evaluateRequestHitResult(undefined);
            }

            if (this.useStaleWhileRevalidate()) {
                return this._evaluateRequestHitResult(this._evaluateRequestRevalidation(req, false));
            }

            return this._evaluateRequestMissResult(req);
        }

        return this._evaluateRequestHitResult(undefined);
    }

    /**
     * @param {HttpRequest} req - check if this is for the same cache entry
     * @param {boolean} allowHeadMethod - allow a HEAD method to match.
     * @returns {boolean} `true` if the request matches.
     */
    _requestMatches(req, allowHeadMethod) {
        // The presented effective request URI and that of the stored response match, and
        return !!(
            (!this._url || this._url === req.url) &&
            this._host === req.headers.host &&
            // the request method associated with the stored response allows it to be used for the presented request, and
            (!req.method ||
                this._method === req.method ||
                (allowHeadMethod && 'HEAD' === req.method)) &&
            // selecting header fields nominated by the stored response (if any) match those presented, and
            this._varyMatches(req)
        );
    }

    /**
     * Determines whether storing authenticated responses is allowed.
     * @returns {boolean} `true` if allowed.
     */
    _allowsStoringAuthenticated() {
        // following Cache-Control response directives (Section 5.2.2) have such an effect: must-revalidate, public, and s-maxage.
        return !!(
            this._rescc['must-revalidate'] ||
            this._rescc.public ||
            this._rescc['s-maxage']
        );
    }

    /**
     * Checks whether the Vary header in the response matches the new request.
     * @param {HttpRequest} req - incoming HTTP request
     * @returns {boolean} `true` if the vary headers match.
     */
    _varyMatches(req) {
        if (!this._resHeaders.vary) {
            return true;
        }

        // A Vary header field-value of "*" always fails to match
        if (this._resHeaders.vary === '*') {
            return false;
        }

        const fields = this._resHeaders.vary
            .trim()
            .toLowerCase()
            .split(/\s*,\s*/);
        for (const name of fields) {
            if (req.headers[name] !== this._reqHeaders[name]) return false;
        }
        return true;
    }

    /**
     * Creates a copy of the given headers without any hop-by-hop headers.
     * @param {Record<string, string>} inHeaders - old headers from the cached response
     * @returns {Record<string, string>} A new headers object without hop-by-hop headers.
     */
    _copyWithoutHopByHopHeaders(inHeaders) {
        /** @type {Record<string, string>} */
        const headers = {};
        for (const name in inHeaders) {
            if (hopByHopHeaders[name]) continue;
            headers[name] = inHeaders[name];
        }
        // 9.1.  Connection
        if (inHeaders.connection) {
            const tokens = inHeaders.connection.trim().split(/\s*,\s*/);
            for (const name of tokens) {
                delete headers[name];
            }
        }
        if (headers.warning) {
            const warnings = headers.warning.split(/,/).filter(warning => {
                return !/^\s*1[0-9][0-9]/.test(warning);
            });
            if (!warnings.length) {
                delete headers.warning;
            } else {
                headers.warning = warnings.join(',').trim();
            }
        }
        return headers;
    }

    /**
     * Returns the response headers adjusted for serving the cached response.
     * Removes hop-by-hop headers and updates the Age and Date headers.
     * @returns {Record<string, string>} The adjusted response headers.
     */
    responseHeaders() {
        const headers = this._copyWithoutHopByHopHeaders(this._resHeaders);
        const age = this.age();

        // A cache SHOULD generate 113 warning if it heuristically chose a freshness
        // lifetime greater than 24 hours and the response's age is greater than 24 hours.
        if (
            age > 3600 * 24 &&
            !this._hasExplicitExpiration() &&
            this.maxAge() > 3600 * 24
        ) {
            headers.warning =
                (headers.warning ? `${headers.warning}, ` : '') +
                '113 - "rfc7234 5.5.4"';
        }
        headers.age = `${Math.round(age)}`;
        headers.date = new Date(this.now()).toUTCString();
        return headers;
    }

    /**
     * Returns the Date header value from the response or the current time if invalid.
     * @returns {number} Timestamp (in milliseconds) representing the Date header or response time.
     */
    date() {
        const serverDate = Date.parse(this._resHeaders.date);
        if (isFinite(serverDate)) {
            return serverDate;
        }
        return this._responseTime;
    }

    /**
     * Value of the Age header, in seconds, updated for the current time.
     * May be fractional.
     * @returns {number} The age in seconds.
     */
    age() {
        let age = this._ageValue();

        const residentTime = (this.now() - this._responseTime) / 1000;
        return age + residentTime;
    }

    /**
     * @returns {number} The Age header value as a number.
     */
    _ageValue() {
        return toNumberOrZero(this._resHeaders.age);
    }

    /**
     * Possibly outdated value of applicable max-age (or heuristic equivalent) in seconds.
     * This counts since response's `Date`.
     *
     * For an up-to-date value, see `timeToLive()`.
     *
     * Returns the maximum age (freshness lifetime) of the response in seconds.
     * @returns {number} The max-age value in seconds.
     */
    maxAge() {
        if (!this.storable() || this._rescc['no-cache']) {
            return 0;
        }

        // Shared responses with cookies are cacheable according to the RFC, but IMHO it'd be unwise to do so by default
        // so this implementation requires explicit opt-in via public header
        if (
            this._isShared &&
            (this._resHeaders['set-cookie'] &&
                !this._rescc.public &&
                !this._rescc.immutable)
        ) {
            return 0;
        }

        if (this._resHeaders.vary === '*') {
            return 0;
        }

        if (this._isShared) {
            if (this._rescc['proxy-revalidate']) {
                return 0;
            }
            // if a response includes the s-maxage directive, a shared cache recipient MUST ignore the Expires field.
            if (this._rescc['s-maxage']) {
                return toNumberOrZero(this._rescc['s-maxage']);
            }
        }

        // If a response includes a Cache-Control field with the max-age directive, a recipient MUST ignore the Expires field.
        if (this._rescc['max-age']) {
            return toNumberOrZero(this._rescc['max-age']);
        }

        const defaultMinTtl = this._rescc.immutable ? this._immutableMinTtl : 0;

        const serverDate = this.date();
        if (this._resHeaders.expires) {
            const expires = Date.parse(this._resHeaders.expires);
            // A cache recipient MUST interpret invalid date formats, especially the value "0", as representing a time in the past (i.e., "already expired").
            if (Number.isNaN(expires) || expires < serverDate) {
                return 0;
            }
            return Math.max(defaultMinTtl, (expires - serverDate) / 1000);
        }

        if (this._resHeaders['last-modified']) {
            const lastModified = Date.parse(this._resHeaders['last-modified']);
            if (isFinite(lastModified) && serverDate > lastModified) {
                return Math.max(
                    defaultMinTtl,
                    ((serverDate - lastModified) / 1000) * this._cacheHeuristic
                );
            }
        }

        return defaultMinTtl;
    }

    /**
     * Remaining time this cache entry may be useful for, in *milliseconds*.
     * You can use this as an expiration time for your cache storage.
     *
     * Prefer this method over `maxAge()`, because it includes other factors like `age` and `stale-while-revalidate`.
     * @returns {number} Time-to-live in milliseconds.
     */
    timeToLive() {
        const age = this.maxAge() - this.age();
        const staleIfErrorAge = age + toNumberOrZero(this._rescc['stale-if-error']);
        const staleWhileRevalidateAge = age + toNumberOrZero(this._rescc['stale-while-revalidate']);
        return Math.round(Math.max(0, age, staleIfErrorAge, staleWhileRevalidateAge) * 1000);
    }

    /**
     * If true, this cache entry is past its expiration date.
     * Note that stale cache may be useful sometimes, see `evaluateRequest()`.
     * @returns {boolean} `false` doesn't mean it's fresh nor usable
     */
    stale() {
        return this.maxAge() <= this.age();
    }

    /**
     * @returns {boolean} `true` if `stale-if-error` condition allows use of a stale response.
     */
    _useStaleIfError() {
        return this.maxAge() + toNumberOrZero(this._rescc['stale-if-error']) > this.age();
    }

    /** See `evaluateRequest()` for a more complete solution
     * @returns {boolean} `true` if `stale-while-revalidate` is currently allowed.
     */
    useStaleWhileRevalidate() {
        const swr = toNumberOrZero(this._rescc['stale-while-revalidate']);
        return swr > 0 && this.maxAge() + swr > this.age();
    }

    /**
     * Creates a `CachePolicy` instance from a serialized object.
     * @param {Object} obj - The serialized object.
     * @returns {CachePolicy} A new CachePolicy instance.
     */
    static fromObject(obj) {
        return new this(undefined, undefined, { _fromObject: obj });
    }

    /**
     * @param {any} obj - The serialized object.
     * @throws {Error} If already initialized or if the object is invalid.
     */
    _fromObject(obj) {
        if (this._responseTime) throw Error('Reinitialized');
        if (!obj || obj.v !== 1) throw Error('Invalid serialization');

        this._responseTime = obj.t;
        this._isShared = obj.sh;
        this._cacheHeuristic = obj.ch;
        this._immutableMinTtl =
            obj.imm !== undefined ? obj.imm : 24 * 3600 * 1000;
        this._ignoreCargoCult = !!obj.icc;
        this._status = obj.st;
        this._resHeaders = obj.resh;
        this._rescc = obj.rescc;
        this._method = obj.m;
        this._url = obj.u;
        this._host = obj.h;
        this._noAuthorization = obj.a;
        this._reqHeaders = obj.reqh;
        this._reqcc = obj.reqcc;
    }

    /**
     * Serializes the `CachePolicy` instance into a JSON-serializable object.
     * @returns {Object} The serialized object.
     */
    toObject() {
        return {
            v: 1,
            t: this._responseTime,
            sh: this._isShared,
            ch: this._cacheHeuristic,
            imm: this._immutableMinTtl,
            icc: this._ignoreCargoCult,
            st: this._status,
            resh: this._resHeaders,
            rescc: this._rescc,
            m: this._method,
            u: this._url,
            h: this._host,
            a: this._noAuthorization,
            reqh: this._reqHeaders,
            reqcc: this._reqcc,
        };
    }

    /**
     * Headers for sending to the origin server to revalidate stale response.
     * Allows server to return 304 to allow reuse of the previous response.
     *
     * Hop by hop headers are always stripped.
     * Revalidation headers may be added or removed, depending on request.
     * @param {HttpRequest} incomingReq - The incoming HTTP request.
     * @returns {Record<string, string>} The headers for the revalidation request.
     */
    revalidationHeaders(incomingReq) {
        this._assertRequestHasHeaders(incomingReq);
        const headers = this._copyWithoutHopByHopHeaders(incomingReq.headers);

        // This implementation does not understand range requests
        delete headers['if-range'];

        if (!this._requestMatches(incomingReq, true) || !this.storable()) {
            // revalidation allowed via HEAD
            // not for the same resource, or wasn't allowed to be cached anyway
            delete headers['if-none-match'];
            delete headers['if-modified-since'];
            return headers;
        }

        /* MUST send that entity-tag in any cache validation request (using If-Match or If-None-Match) if an entity-tag has been provided by the origin server. */
        if (this._resHeaders.etag) {
            headers['if-none-match'] = headers['if-none-match']
                ? `${headers['if-none-match']}, ${this._resHeaders.etag}`
                : this._resHeaders.etag;
        }

        // Clients MAY issue simple (non-subrange) GET requests with either weak validators or strong validators. Clients MUST NOT use weak validators in other forms of request.
        const forbidsWeakValidators =
            headers['accept-ranges'] ||
            headers['if-match'] ||
            headers['if-unmodified-since'] ||
            (this._method && this._method != 'GET');

        /* SHOULD send the Last-Modified value in non-subrange cache validation requests (using If-Modified-Since) if only a Last-Modified value has been provided by the origin server.
        Note: This implementation does not understand partial responses (206) */
        if (forbidsWeakValidators) {
            delete headers['if-modified-since'];

            if (headers['if-none-match']) {
                const etags = headers['if-none-match']
                    .split(/,/)
                    .filter(etag => {
                        return !/^\s*W\//.test(etag);
                    });
                if (!etags.length) {
                    delete headers['if-none-match'];
                } else {
                    headers['if-none-match'] = etags.join(',').trim();
                }
            }
        } else if (
            this._resHeaders['last-modified'] &&
            !headers['if-modified-since']
        ) {
            headers['if-modified-since'] = this._resHeaders['last-modified'];
        }

        return headers;
    }

    /**
     * Creates new CachePolicy with information combined from the previews response,
     * and the new revalidation response.
     *
     * Returns {policy, modified} where modified is a boolean indicating
     * whether the response body has been modified, and old cached body can't be used.
     *
     * @param {HttpRequest} request - The latest HTTP request asking for the cached entry.
     * @param {HttpResponse} response - The latest revalidation HTTP response from the origin server.
     * @returns {{policy: CachePolicy, modified: boolean, matches: boolean}} The updated policy and modification status.
     * @throws {Error} If the response headers are missing.
     */
    revalidatedPolicy(request, response) {
        this._assertRequestHasHeaders(request);

        if (this._useStaleIfError() && isErrorResponse(response)) {
          return {
              policy: this,
              modified: false,
              matches: true,
          };
        }

        if (!response || !response.headers) {
            throw Error('Response headers missing');
        }

        // These aren't going to be supported exactly, since one CachePolicy object
        // doesn't know about all the other cached objects.
        let matches = false;
        if (response.status !== undefined && response.status != 304) {
            matches = false;
        } else if (
            response.headers.etag &&
            !/^\s*W\//.test(response.headers.etag)
        ) {
            // "All of the stored responses with the same strong validator are selected.
            // If none of the stored responses contain the same strong validator,
            // then the cache MUST NOT use the new response to update any stored responses."
            matches =
                this._resHeaders.etag &&
                this._resHeaders.etag.replace(/^\s*W\//, '') ===
                    response.headers.etag;
        } else if (this._resHeaders.etag && response.headers.etag) {
            // "If the new response contains a weak validator and that validator corresponds
            // to one of the cache's stored responses,
            // then the most recent of those matching stored responses is selected for update."
            matches =
                this._resHeaders.etag.replace(/^\s*W\//, '') ===
                response.headers.etag.replace(/^\s*W\//, '');
        } else if (this._resHeaders['last-modified']) {
            matches =
                this._resHeaders['last-modified'] ===
                response.headers['last-modified'];
        } else {
            // If the new response does not include any form of validator (such as in the case where
            // a client generates an If-Modified-Since request from a source other than the Last-Modified
            // response header field), and there is only one stored response, and that stored response also
            // lacks a validator, then that stored response is selected for update.
            if (
                !this._resHeaders.etag &&
                !this._resHeaders['last-modified'] &&
                !response.headers.etag &&
                !response.headers['last-modified']
            ) {
                matches = true;
            }
        }

        const optionsCopy = {
            shared: this._isShared,
            cacheHeuristic: this._cacheHeuristic,
            immutableMinTimeToLive: this._immutableMinTtl,
            ignoreCargoCult: this._ignoreCargoCult,
        };

        if (!matches) {
            return {
                policy: new this.constructor(request, response, optionsCopy),
                // Client receiving 304 without body, even if it's invalid/mismatched has no option
                // but to reuse a cached body. We don't have a good way to tell clients to do
                // error recovery in such case.
                modified: response.status != 304,
                matches: false,
            };
        }

        // use other header fields provided in the 304 (Not Modified) response to replace all instances
        // of the corresponding header fields in the stored response.
        const headers = {};
        for (const k in this._resHeaders) {
            headers[k] =
                k in response.headers && !excludedFromRevalidationUpdate[k]
                    ? response.headers[k]
                    : this._resHeaders[k];
        }

        const newResponse = Object.assign({}, response, {
            status: this._status,
            method: this._method,
            headers,
        });
        return {
            policy: new this.constructor(request, newResponse, optionsCopy),
            modified: false,
            matches: true,
        };
    }
};


/***/ }),

/***/ 65074:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  "default": () => (/* binding */ source)
});

// UNUSED EXPORTS: AbortError, CacheError, HTTPError, MaxRedirectsError, Options, ParseError, ReadError, RequestError, RetryError, TimeoutError, UploadError, applyUrlOverride, assertUrlHasSameOriginAsPrefixUrlIfNeeded, cacheDecodedBody, calculateRetryDelay, copyRedirectDecision, create, crossOriginStripHeaders, decodeUint8Array, generateRequestId, getUrlPrefixBoundary, hasBodyOptionChanged, hasExplicitCredentialInUrlChange, hasUrlOrPrefixUrlBoundaryChanged, isBodyUnchanged, isCrossOriginCredentialChanged, isResponseOk, isSameOrigin, isUtf8Encoding, normalizeError, parseBody, parseLinkHeader, publishError, publishRedirect, publishRequestCreate, publishRequestStart, publishResponseEnd, publishResponseStart, publishRetry, snapshotCrossOriginState

// EXTERNAL MODULE: external "node:timers/promises"
var promises_ = __webpack_require__(58500);
;// CONCATENATED MODULE: ./node_modules/@sindresorhus/is/distribution/utilities.js
function keysOf(value) {
    return Object.keys(value);
}

;// CONCATENATED MODULE: ./node_modules/@sindresorhus/is/distribution/index.js

const typedArrayTypeNames = [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
];
function isTypedArrayName(name) {
    return typedArrayTypeNames.includes(name);
}
const objectTypeNames = [
    'Function',
    'Generator',
    'AsyncGenerator',
    'GeneratorFunction',
    'AsyncGeneratorFunction',
    'AsyncFunction',
    'Observable',
    'Array',
    'Buffer',
    'Blob',
    'Object',
    'RegExp',
    'Date',
    'Error',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'WeakRef',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Promise',
    'URL',
    'FormData',
    'URLSearchParams',
    'HTMLElement',
    'NaN',
    ...typedArrayTypeNames,
];
function isObjectTypeName(name) {
    return objectTypeNames.includes(name);
}
const primitiveTypeNames = [
    'null',
    'undefined',
    'string',
    'number',
    'bigint',
    'boolean',
    'symbol',
];
function isPrimitiveTypeName(name) {
    return primitiveTypeNames.includes(name);
}
const assertionTypeDescriptions = [
    'bound Function',
    'positive number',
    'negative number',
    'Class',
    'string with a number',
    'null or undefined',
    'Iterable',
    'AsyncIterable',
    'native Promise',
    'EnumCase',
    'string with a URL',
    'truthy',
    'falsy',
    'primitive',
    'integer',
    'plain object',
    'TypedArray',
    'array-like',
    'tuple-like',
    'Node.js Stream',
    'infinite number',
    'empty array',
    'non-empty array',
    'empty string',
    'empty string or whitespace',
    'non-empty string',
    'non-empty string and not whitespace',
    'empty object',
    'non-empty object',
    'empty set',
    'non-empty set',
    'empty map',
    'non-empty map',
    'PropertyKey',
    'even integer',
    'finite number',
    'negative integer',
    'non-negative integer',
    'non-negative number',
    'odd integer',
    'positive integer',
    'safe integer',
    'T',
    'in range',
    'predicate returns truthy for any value',
    'predicate returns truthy for all values',
    'valid Date',
    'valid length',
    'whitespace string',
    ...objectTypeNames,
    ...primitiveTypeNames,
];
const getObjectType = (value) => {
    const objectTypeName = Object.prototype.toString.call(value).slice(8, -1);
    if (/HTML\w+Element/v.test(objectTypeName) && isHtmlElement(value)) {
        return 'HTMLElement';
    }
    if (isObjectTypeName(objectTypeName)) {
        return objectTypeName;
    }
    return undefined;
};
function detect(value) {
    if (value === null) {
        return 'null';
    }
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
    switch (typeof value) {
        case 'undefined': {
            return 'undefined';
        }
        case 'string': {
            return 'string';
        }
        case 'number': {
            return Number.isNaN(value) ? 'NaN' : 'number';
        }
        case 'boolean': {
            return 'boolean';
        }
        case 'function': {
            return 'Function';
        }
        case 'bigint': {
            return 'bigint';
        }
        case 'symbol': {
            return 'symbol';
        }
        default:
    }
    if (isObservable(value)) {
        return 'Observable';
    }
    if (isArray(value)) {
        return 'Array';
    }
    if (isBuffer(value)) {
        return 'Buffer';
    }
    const tagType = getObjectType(value);
    if (tagType !== undefined && tagType !== 'Object') {
        return tagType;
    }
    if (hasPromiseApi(value)) {
        return 'Promise';
    }
    if (isBoxedPrimitiveObject(value)) {
        throw new TypeError('Please don\'t use object wrappers for primitive types');
    }
    return 'Object';
}
function hasPromiseApi(value) {
    return isFunction(value?.then) && isFunction(value?.catch);
}
function hasBoxedPrimitiveBrand(value, valueOf) {
    try {
        // `Object.prototype.toString` can be spoofed via `Symbol.toStringTag`, but the
        // boxed primitive `valueOf` methods still enforce the real internal brand.
        Reflect.apply(valueOf, value, []);
        return true;
    }
    catch {
        return false;
    }
}
function isBoxedPrimitiveObject(value) {
    return hasBoxedPrimitiveBrand(value, String.prototype.valueOf)
        || hasBoxedPrimitiveBrand(value, Boolean.prototype.valueOf)
        || hasBoxedPrimitiveBrand(value, Number.prototype.valueOf);
}
const is = Object.assign(detect, {
    all: isAll,
    any: isAny,
    array: isArray,
    arrayBuffer: isArrayBuffer,
    arrayLike: isArrayLike,
    arrayOf: isArrayOf,
    asyncFunction: isAsyncFunction,
    asyncGenerator: isAsyncGenerator,
    asyncGeneratorFunction: isAsyncGeneratorFunction,
    asyncIterable: isAsyncIterable,
    bigint: isBigint,
    bigInt64Array: isBigInt64Array,
    bigUint64Array: isBigUint64Array,
    blob: isBlob,
    boolean: isBoolean,
    boundFunction: isBoundFunction,
    buffer: isBuffer,
    class: isClass,
    dataView: isDataView,
    date: isDate,
    detect,
    directInstanceOf: isDirectInstanceOf,
    emptyArray: isEmptyArray,
    emptyMap: isEmptyMap,
    emptyObject: isEmptyObject,
    emptySet: isEmptySet,
    emptyString: isEmptyString,
    emptyStringOrWhitespace: isEmptyStringOrWhitespace,
    enumCase: isEnumCase,
    error: isError,
    evenInteger: isEvenInteger,
    falsy: isFalsy,
    finiteNumber: isFiniteNumber,
    float32Array: isFloat32Array,
    float64Array: isFloat64Array,
    formData: isFormData,
    function: isFunction,
    generator: isGenerator,
    generatorFunction: isGeneratorFunction,
    htmlElement: isHtmlElement,
    infinite: isInfinite,
    inRange: isInRange,
    int16Array: isInt16Array,
    int32Array: isInt32Array,
    int8Array: isInt8Array,
    integer: isInteger,
    iterable: isIterable,
    map: isMap,
    nan: isNan,
    nativePromise: isNativePromise,
    negativeInteger: isNegativeInteger,
    negativeNumber: isNegativeNumber,
    nodeStream: isNodeStream,
    nonEmptyArray: isNonEmptyArray,
    nonEmptyMap: isNonEmptyMap,
    nonEmptyObject: isNonEmptyObject,
    nonEmptySet: isNonEmptySet,
    nonEmptyString: isNonEmptyString,
    nonEmptyStringAndNotWhitespace: isNonEmptyStringAndNotWhitespace,
    nonNegativeInteger: isNonNegativeInteger,
    nonNegativeNumber: isNonNegativeNumber,
    null: isNull,
    nullOrUndefined: isNullOrUndefined,
    number: isNumber,
    numericString: isNumericString,
    object: isObject,
    observable: isObservable,
    oddInteger: isOddInteger,
    oneOf: isOneOf,
    plainObject: isPlainObject,
    positiveInteger: isPositiveInteger,
    positiveNumber: isPositiveNumber,
    primitive: isPrimitive,
    promise: isPromise,
    propertyKey: isPropertyKey,
    regExp: isRegExp,
    safeInteger: isSafeInteger,
    set: isSet,
    sharedArrayBuffer: isSharedArrayBuffer,
    string: isString,
    symbol: isSymbol,
    truthy: isTruthy,
    tupleLike: isTupleLike,
    typedArray: isTypedArray,
    uint16Array: isUint16Array,
    uint32Array: isUint32Array,
    uint8Array: isUint8Array,
    uint8ClampedArray: isUint8ClampedArray,
    undefined: isUndefined,
    urlInstance: isUrlInstance,
    urlSearchParams: isUrlSearchParams,
    urlString: isUrlString,
    optional: isOptional,
    validDate: isValidDate,
    validLength: isValidLength,
    weakMap: isWeakMap,
    weakRef: isWeakRef,
    weakSet: isWeakSet,
    whitespaceString: isWhitespaceString,
});
function isAbsoluteModule2(remainder) {
    return (value) => isInteger(value) && Math.abs(value % 2) === remainder;
}
function validatePredicateArray(predicateArray, allowEmpty) {
    if (predicateArray.length === 0) {
        if (allowEmpty) {
            // Next major release: throw for empty predicate arrays to avoid vacuous results.
            // throw new TypeError('Invalid predicate array');
        }
        else {
            throw new TypeError('Invalid predicate array');
        }
        return;
    }
    for (const predicate of predicateArray) {
        validatePredicate(predicate);
    }
}
function validatePredicate(predicate) {
    if (!isFunction(predicate)) {
        throw new TypeError(`Invalid predicate: ${JSON.stringify(predicate)}`);
    }
}
function isAll(predicate, ...values) {
    if (Array.isArray(predicate)) {
        const predicateArray = predicate;
        validatePredicateArray(predicateArray, values.length === 0);
        const combinedPredicate = (value) => predicateArray.every(singlePredicate => singlePredicate(value));
        if (values.length === 0) {
            return combinedPredicate;
        }
        return predicateOnArray(Array.prototype.every, combinedPredicate, values);
    }
    return predicateOnArray(Array.prototype.every, predicate, values);
}
function isAny(predicate, ...values) {
    if (Array.isArray(predicate)) {
        const predicateArray = predicate;
        validatePredicateArray(predicateArray, values.length === 0);
        const combinedPredicate = (value) => predicateArray.some(singlePredicate => singlePredicate(value));
        if (values.length === 0) {
            return combinedPredicate;
        }
        return predicateOnArray(Array.prototype.some, combinedPredicate, values);
    }
    return predicateOnArray(Array.prototype.some, predicate, values);
}
function isOptional(value, predicate) {
    return isUndefined(value) || predicate(value);
}
function isArray(value, assertion) {
    if (!Array.isArray(value)) {
        return false;
    }
    if (!isFunction(assertion)) {
        return true;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return value.every(element => assertion(element));
}
function isArrayBuffer(value) {
    return getObjectType(value) === 'ArrayBuffer';
}
function isArrayLike(value) {
    return !isNullOrUndefined(value) && !isFunction(value) && isValidLength(value.length);
}
function isArrayOf(predicate) {
    return (value) => isArray(value) && value.every(element => predicate(element));
}
function isAsyncFunction(value) {
    return getObjectType(value) === 'AsyncFunction';
}
function isAsyncGenerator(value) {
    return isAsyncIterable(value) && isFunction(value.next) && isFunction(value.throw);
}
function isAsyncGeneratorFunction(value) {
    return getObjectType(value) === 'AsyncGeneratorFunction';
}
function isAsyncIterable(value) {
    return isFunction(value?.[Symbol.asyncIterator]);
}
function isBigint(value) {
    return typeof value === 'bigint';
}
function isBigInt64Array(value) {
    return getObjectType(value) === 'BigInt64Array';
}
function isBigUint64Array(value) {
    return getObjectType(value) === 'BigUint64Array';
}
function isBlob(value) {
    return getObjectType(value) === 'Blob';
}
function isBoolean(value) {
    return value === true || value === false;
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function isBoundFunction(value) {
    return isFunction(value) && !Object.hasOwn(value, 'prototype');
}
/**
Note: [Prefer using `Uint8Array` instead of `Buffer`.](https://sindresorhus.com/blog/goodbye-nodejs-buffer)
*/
function isBuffer(value) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return value?.constructor?.isBuffer?.(value) ?? false;
}
function isClass(value) {
    return isFunction(value) && /^class(?:\s+|\{)/v.test(value.toString());
}
function isDataView(value) {
    return getObjectType(value) === 'DataView';
}
function isDate(value) {
    return getObjectType(value) === 'Date';
}
function isDirectInstanceOf(instance, class_) {
    if (instance === undefined || instance === null) {
        return false;
    }
    return Object.getPrototypeOf(instance) === class_.prototype;
}
function isEmptyArray(value) {
    return isArray(value) && value.length === 0;
}
function isEmptyMap(value) {
    return isMap(value) && value.size === 0;
}
function isEmptyObject(value) {
    return isObject(value) && !isFunction(value) && !isArray(value) && !isMap(value) && !isSet(value) && Object.keys(value).length === 0;
}
function isEmptySet(value) {
    return isSet(value) && value.size === 0;
}
function isEmptyString(value) {
    return isString(value) && value.length === 0;
}
function isEmptyStringOrWhitespace(value) {
    return isEmptyString(value) || isWhitespaceString(value);
}
function isEnumCase(value, targetEnum) {
    // Numeric enums have reverse mappings (e.g. `Direction[0] = "Up"`), so their runtime object contains both `{ Up: 0 }` and `{ "0": "Up" }`. Filtering out entries that round-trip like a canonical number and point back to an own property leaves only actual enum member values.
    const enumObject = targetEnum;
    return Object.entries(enumObject).some(([key, enumValue]) => {
        if (!isString(enumValue)) {
            return enumValue === value;
        }
        const numericKey = Number(key);
        if (Number.isNaN(numericKey) || String(numericKey) !== key) {
            return enumValue === value;
        }
        return enumValue === value && !(Object.hasOwn(enumObject, enumValue) && enumObject[enumValue] === numericKey);
    });
}
function isError(value) {
    // TODO: Use `Error.isError` when targeting Node.js 24.
    return getObjectType(value) === 'Error';
}
function isEvenInteger(value) {
    return isAbsoluteModule2(0)(value);
}
// Example: `is.falsy = (value: unknown): value is (not true | 0 | '' | undefined | null) => Boolean(value);`
function isFalsy(value) {
    return !value;
}
function isFiniteNumber(value) {
    return Number.isFinite(value);
}
// TODO: Support detecting Float16Array when targeting Node.js 24.
function isFloat32Array(value) {
    return getObjectType(value) === 'Float32Array';
}
function isFloat64Array(value) {
    return getObjectType(value) === 'Float64Array';
}
function isFormData(value) {
    return getObjectType(value) === 'FormData';
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function isFunction(value) {
    return typeof value === 'function';
}
function isGenerator(value) {
    return isIterable(value) && isFunction(value?.next) && isFunction(value?.throw);
}
function isGeneratorFunction(value) {
    return getObjectType(value) === 'GeneratorFunction';
}
const NODE_TYPE_ELEMENT = 1; // eslint-disable-line @typescript-eslint/naming-convention
const DOM_PROPERTIES_TO_CHECK = [
    'innerHTML',
    'ownerDocument',
    'style',
    'attributes',
    'nodeValue',
];
function isHtmlElement(value) {
    return isObject(value)
        && value.nodeType === NODE_TYPE_ELEMENT
        && isString(value.nodeName)
        && !isPlainObject(value)
        && DOM_PROPERTIES_TO_CHECK.every(property => property in value);
}
function isInfinite(value) {
    return value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY;
}
function isInRange(value, range) {
    if (isNumber(range)) {
        return value >= Math.min(0, range) && value <= Math.max(range, 0);
    }
    if (isArray(range) && range.length === 2) {
        if (Number.isNaN(range[0]) || Number.isNaN(range[1])) {
            throw new TypeError(`Invalid range: ${JSON.stringify(range)}`);
        }
        return value >= Math.min(...range) && value <= Math.max(...range);
    }
    throw new TypeError(`Invalid range: ${JSON.stringify(range)}`);
}
function isInt16Array(value) {
    return getObjectType(value) === 'Int16Array';
}
function isInt32Array(value) {
    return getObjectType(value) === 'Int32Array';
}
function isInt8Array(value) {
    return getObjectType(value) === 'Int8Array';
}
function isInteger(value) {
    return Number.isInteger(value);
}
function isIterable(value) {
    return isFunction(value?.[Symbol.iterator]);
}
function isMap(value) {
    return getObjectType(value) === 'Map';
}
function isNan(value) {
    return Number.isNaN(value);
}
function isNativePromise(value) {
    return getObjectType(value) === 'Promise';
}
function isNegativeInteger(value) {
    return isInteger(value) && value < 0;
}
function isNegativeNumber(value) {
    return isNumber(value) && value < 0;
}
function isNodeStream(value) {
    return isObject(value) && isFunction(value.pipe) && !isObservable(value);
}
function isNonEmptyArray(value) {
    return isArray(value) && value.length > 0;
}
function isNonEmptyMap(value) {
    return isMap(value) && value.size > 0;
}
// TODO: Use `not` operator here to remove `Map` and `Set` from type guard:
// - https://github.com/Microsoft/TypeScript/pull/29317
function isNonEmptyObject(value) {
    return isObject(value) && !isFunction(value) && !isArray(value) && !isMap(value) && !isSet(value) && Object.keys(value).length > 0;
}
function isNonEmptySet(value) {
    return isSet(value) && value.size > 0;
}
// TODO: Use `not ''` when the `not` operator is available.
function isNonEmptyString(value) {
    return isString(value) && value.length > 0;
}
// TODO: Use `not ''` when the `not` operator is available.
function isNonEmptyStringAndNotWhitespace(value) {
    return isString(value) && !isEmptyStringOrWhitespace(value);
}
function isNonNegativeInteger(value) {
    return isInteger(value) && value >= 0;
}
function isNonNegativeNumber(value) {
    return isNumber(value) && value >= 0;
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function isNull(value) {
    return value === null;
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function isNullOrUndefined(value) {
    return isNull(value) || isUndefined(value);
}
function isNumber(value) {
    return typeof value === 'number' && !Number.isNaN(value);
}
function isNumericString(value) {
    return isString(value) && !isEmptyStringOrWhitespace(value) && value === value.trim() && !Number.isNaN(Number(value));
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function isObject(value) {
    return !isNull(value) && (typeof value === 'object' || isFunction(value));
}
function isObservable(value) {
    if (!value) {
        return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    if (Symbol.observable !== undefined && value === value[Symbol.observable]?.()) {
        return true;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    if (value === value['@@observable']?.()) {
        return true;
    }
    return false;
}
function isOddInteger(value) {
    return isAbsoluteModule2(1)(value);
}
function isOneOf(values) {
    return (value) => values.includes(value);
}
function isPlainObject(value) {
    // From: https://github.com/sindresorhus/is-plain-obj/blob/main/index.js
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const prototype = Object.getPrototypeOf(value);
    return (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value);
}
function isPositiveInteger(value) {
    return isInteger(value) && value > 0;
}
function isPositiveNumber(value) {
    return isNumber(value) && value > 0;
}
function isPrimitive(value) {
    return isNull(value) || isPrimitiveTypeName(typeof value);
}
function isPromise(value) {
    return isNativePromise(value) || hasPromiseApi(value);
}
// `PropertyKey` is any value that can be used as an object key (string, number, or symbol). Note: NaN is technically `typeof 'number'` and thus fits TypeScript's `PropertyKey`, but we intentionally exclude it here because using NaN as a property key is almost always a mistake.
function isPropertyKey(value) {
    return isAny([isString, isNumber, isSymbol], value);
}
function isRegExp(value) {
    return getObjectType(value) === 'RegExp';
}
function isSafeInteger(value) {
    return Number.isSafeInteger(value);
}
function isSet(value) {
    return getObjectType(value) === 'Set';
}
function isSharedArrayBuffer(value) {
    return getObjectType(value) === 'SharedArrayBuffer';
}
function isString(value) {
    return typeof value === 'string';
}
function isSymbol(value) {
    return typeof value === 'symbol';
}
// Example: `is.truthy = (value: unknown): value is (not false | not 0 | not '' | not undefined | not null) => Boolean(value);`
// eslint-disable-next-line unicorn/prefer-native-coercion-functions
function isTruthy(value) {
    return Boolean(value);
}
function isTupleLike(value, guards) {
    if (isArray(guards) && isArray(value) && guards.length === value.length) {
        return guards.every((guard, index) => guard(value[index]));
    }
    return false;
}
function isTypedArray(value) {
    return isTypedArrayName(getObjectType(value));
}
function isUint16Array(value) {
    return getObjectType(value) === 'Uint16Array';
}
function isUint32Array(value) {
    return getObjectType(value) === 'Uint32Array';
}
function isUint8Array(value) {
    return getObjectType(value) === 'Uint8Array';
}
function isUint8ClampedArray(value) {
    return getObjectType(value) === 'Uint8ClampedArray';
}
function isUndefined(value) {
    return value === undefined;
}
function isUrlInstance(value) {
    return getObjectType(value) === 'URL';
}
// eslint-disable-next-line unicorn/prevent-abbreviations
function isUrlSearchParams(value) {
    return getObjectType(value) === 'URLSearchParams';
}
function isUrlString(value) {
    if (!isString(value)) {
        return false;
    }
    try {
        new URL(value); // eslint-disable-line no-new
        return true;
    }
    catch {
        return false;
    }
}
function isValidDate(value) {
    return isDate(value) && !isNan(Number(value));
}
function isValidLength(value) {
    return isSafeInteger(value) && value >= 0;
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function isWeakMap(value) {
    return getObjectType(value) === 'WeakMap';
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function isWeakRef(value) {
    return getObjectType(value) === 'WeakRef';
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function isWeakSet(value) {
    return getObjectType(value) === 'WeakSet';
}
function isWhitespaceString(value) {
    return isString(value) && /^\s+$/v.test(value);
}
function predicateOnArray(method, predicate, values) {
    validatePredicate(predicate);
    if (values.length === 0) {
        throw new TypeError('Invalid number of values');
    }
    return method.call(values, predicate);
}
function typeErrorMessage(description, value) {
    return `Expected value which is \`${description}\`, received value of type \`${is(value)}\`.`;
}
function typeErrorMessageNot(description, value) {
    return `Expected value which is not \`${description}\`, received value of type \`${is(value)}\`.`;
}
function unique(values) {
    // eslint-disable-next-line unicorn/prefer-spread
    return Array.from(new Set(values));
}
const andFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
const orFormatter = new Intl.ListFormat('en', { style: 'long', type: 'disjunction' });
function typeErrorMessageMultipleValues(expectedType, values) {
    const uniqueExpectedTypes = unique((isArray(expectedType) ? expectedType : [expectedType]).map(value => `\`${value}\``));
    const uniqueValueTypes = unique(values.map(value => `\`${is(value)}\``));
    return `Expected values which are ${orFormatter.format(uniqueExpectedTypes)}. Received values of type${uniqueValueTypes.length > 1 ? 's' : ''} ${andFormatter.format(uniqueValueTypes)}.`;
}
// Negative assertions are limited to types where the assertion rejects every TypeScript value assignable to the forbidden type. Structural object types such as `Map`, `Set`, `Date`, and `Array` are excluded because TypeScript accepts shape-compatible mocks while the runtime checks use object brands, so `Exclude` would narrow values that can pass the negative assertion.
function createAssertNot(predicate, description) {
    return (value, message) => {
        if (predicate(value)) {
            throw new TypeError(message ?? typeErrorMessageNot(description, value));
        }
    };
}
const assertNotUndefined = createAssertNot(isUndefined, 'undefined');
// eslint-disable-next-line @typescript-eslint/no-restricted-types
const assertNotNull = createAssertNot(isNull, 'null');
// eslint-disable-next-line @typescript-eslint/no-restricted-types
const assertNotNullOrUndefined 
// eslint-disable-next-line @typescript-eslint/no-restricted-types
= createAssertNot(isNullOrUndefined, 'null or undefined');
const assertNotString = createAssertNot(isString, 'string');
const assertNotBoolean = createAssertNot(isBoolean, 'boolean');
const assertNotSymbol = createAssertNot(isSymbol, 'symbol');
const assertNotBigint = createAssertNot(isBigint, 'bigint');
const assertNotPrimitive = createAssertNot(isPrimitive, 'primitive'); // eslint-disable-line @typescript-eslint/no-restricted-types
// We intentionally do not support `assert.not(is.undefined, value)`. TypeScript cannot derive safe complement types from arbitrary predicates, and many predicates here are refinements (for example, `is.number` rejects `NaN`). Explicit methods keep runtime checks and type narrowing aligned.
const notAssertions = {
    bigint: assertNotBigint,
    boolean: assertNotBoolean,
    null: assertNotNull,
    nullOrUndefined: assertNotNullOrUndefined,
    primitive: assertNotPrimitive,
    string: assertNotString,
    symbol: assertNotSymbol,
    undefined: assertNotUndefined,
};
const assert = {
    all: assertAll,
    any: assertAny,
    not: notAssertions,
    optional: assertOptional,
    array: assertArray,
    arrayBuffer: assertArrayBuffer,
    arrayLike: assertArrayLike,
    asyncFunction: assertAsyncFunction,
    asyncGenerator: assertAsyncGenerator,
    asyncGeneratorFunction: assertAsyncGeneratorFunction,
    asyncIterable: assertAsyncIterable,
    bigint: assertBigint,
    bigInt64Array: assertBigInt64Array,
    bigUint64Array: assertBigUint64Array,
    blob: assertBlob,
    boolean: assertBoolean,
    boundFunction: assertBoundFunction,
    buffer: assertBuffer,
    class: assertClass,
    dataView: assertDataView,
    date: assertDate,
    directInstanceOf: assertDirectInstanceOf,
    emptyArray: assertEmptyArray,
    emptyMap: assertEmptyMap,
    emptyObject: assertEmptyObject,
    emptySet: assertEmptySet,
    emptyString: assertEmptyString,
    emptyStringOrWhitespace: assertEmptyStringOrWhitespace,
    enumCase: assertEnumCase,
    error: assertError,
    evenInteger: assertEvenInteger,
    falsy: assertFalsy,
    finiteNumber: assertFiniteNumber,
    float32Array: assertFloat32Array,
    float64Array: assertFloat64Array,
    formData: assertFormData,
    function: assertFunction,
    generator: assertGenerator,
    generatorFunction: assertGeneratorFunction,
    htmlElement: assertHtmlElement,
    infinite: assertInfinite,
    inRange: assertInRange,
    int16Array: assertInt16Array,
    int32Array: assertInt32Array,
    int8Array: assertInt8Array,
    integer: assertInteger,
    iterable: assertIterable,
    map: assertMap,
    nan: assertNan,
    nativePromise: assertNativePromise,
    negativeInteger: assertNegativeInteger,
    negativeNumber: assertNegativeNumber,
    nodeStream: assertNodeStream,
    nonEmptyArray: assertNonEmptyArray,
    nonEmptyMap: assertNonEmptyMap,
    nonEmptyObject: assertNonEmptyObject,
    nonEmptySet: assertNonEmptySet,
    nonEmptyString: assertNonEmptyString,
    nonEmptyStringAndNotWhitespace: assertNonEmptyStringAndNotWhitespace,
    nonNegativeInteger: assertNonNegativeInteger,
    nonNegativeNumber: assertNonNegativeNumber,
    null: assertNull,
    nullOrUndefined: assertNullOrUndefined,
    number: assertNumber,
    numericString: assertNumericString,
    object: assertObject,
    observable: assertObservable,
    oddInteger: assertOddInteger,
    plainObject: assertPlainObject,
    positiveInteger: assertPositiveInteger,
    positiveNumber: assertPositiveNumber,
    primitive: assertPrimitive,
    promise: assertPromise,
    propertyKey: assertPropertyKey,
    regExp: assertRegExp,
    safeInteger: assertSafeInteger,
    set: assertSet,
    sharedArrayBuffer: assertSharedArrayBuffer,
    string: assertString,
    symbol: assertSymbol,
    truthy: assertTruthy,
    tupleLike: assertTupleLike,
    typedArray: assertTypedArray,
    uint16Array: assertUint16Array,
    uint32Array: assertUint32Array,
    uint8Array: assertUint8Array,
    uint8ClampedArray: assertUint8ClampedArray,
    undefined: assertUndefined,
    urlInstance: assertUrlInstance,
    urlSearchParams: assertUrlSearchParams,
    urlString: assertUrlString,
    validDate: assertValidDate,
    validLength: assertValidLength,
    weakMap: assertWeakMap,
    weakRef: assertWeakRef,
    weakSet: assertWeakSet,
    whitespaceString: assertWhitespaceString,
};
const methodTypeMap = {
    isArray: 'Array',
    isArrayBuffer: 'ArrayBuffer',
    isArrayLike: 'array-like',
    isAsyncFunction: 'AsyncFunction',
    isAsyncGenerator: 'AsyncGenerator',
    isAsyncGeneratorFunction: 'AsyncGeneratorFunction',
    isAsyncIterable: 'AsyncIterable',
    isBigint: 'bigint',
    isBigInt64Array: 'BigInt64Array',
    isBigUint64Array: 'BigUint64Array',
    isBlob: 'Blob',
    isBoolean: 'boolean',
    isBoundFunction: 'bound Function',
    isBuffer: 'Buffer',
    isClass: 'Class',
    isDataView: 'DataView',
    isDate: 'Date',
    isDirectInstanceOf: 'T',
    isEmptyArray: 'empty array',
    isEmptyMap: 'empty map',
    isEmptyObject: 'empty object',
    isEmptySet: 'empty set',
    isEmptyString: 'empty string',
    isEmptyStringOrWhitespace: 'empty string or whitespace',
    isEnumCase: 'EnumCase',
    isError: 'Error',
    isEvenInteger: 'even integer',
    isFalsy: 'falsy',
    isFiniteNumber: 'finite number',
    isFloat32Array: 'Float32Array',
    isFloat64Array: 'Float64Array',
    isFormData: 'FormData',
    isFunction: 'Function',
    isGenerator: 'Generator',
    isGeneratorFunction: 'GeneratorFunction',
    isHtmlElement: 'HTMLElement',
    isInfinite: 'infinite number',
    isInRange: 'in range',
    isInt16Array: 'Int16Array',
    isInt32Array: 'Int32Array',
    isInt8Array: 'Int8Array',
    isInteger: 'integer',
    isIterable: 'Iterable',
    isMap: 'Map',
    isNan: 'NaN',
    isNativePromise: 'native Promise',
    isNegativeInteger: 'negative integer',
    isNegativeNumber: 'negative number',
    isNodeStream: 'Node.js Stream',
    isNonEmptyArray: 'non-empty array',
    isNonEmptyMap: 'non-empty map',
    isNonEmptyObject: 'non-empty object',
    isNonEmptySet: 'non-empty set',
    isNonEmptyString: 'non-empty string',
    isNonEmptyStringAndNotWhitespace: 'non-empty string and not whitespace',
    isNonNegativeInteger: 'non-negative integer',
    isNonNegativeNumber: 'non-negative number',
    isNull: 'null',
    isNullOrUndefined: 'null or undefined',
    isNumber: 'number',
    isNumericString: 'string with a number',
    isObject: 'Object',
    isObservable: 'Observable',
    isOddInteger: 'odd integer',
    isPlainObject: 'plain object',
    isPositiveInteger: 'positive integer',
    isPositiveNumber: 'positive number',
    isPrimitive: 'primitive',
    isPromise: 'Promise',
    isPropertyKey: 'PropertyKey',
    isRegExp: 'RegExp',
    isSafeInteger: 'safe integer',
    isSet: 'Set',
    isSharedArrayBuffer: 'SharedArrayBuffer',
    isString: 'string',
    isSymbol: 'symbol',
    isTruthy: 'truthy',
    isTupleLike: 'tuple-like',
    isTypedArray: 'TypedArray',
    isUint16Array: 'Uint16Array',
    isUint32Array: 'Uint32Array',
    isUint8Array: 'Uint8Array',
    isUint8ClampedArray: 'Uint8ClampedArray',
    isUndefined: 'undefined',
    isUrlInstance: 'URL',
    isUrlSearchParams: 'URLSearchParams',
    isUrlString: 'string with a URL',
    isValidDate: 'valid Date',
    isValidLength: 'valid length',
    isWeakMap: 'WeakMap',
    isWeakRef: 'WeakRef',
    isWeakSet: 'WeakSet',
    isWhitespaceString: 'whitespace string',
};
const isMethodNames = keysOf(methodTypeMap);
function isIsMethodName(value) {
    return isMethodNames.includes(value);
}
function assertAll(predicate, ...values) {
    if (values.length === 0) {
        throw new TypeError('Invalid number of values');
    }
    if (!isAll(predicate, ...values)) {
        const predicateFunction = predicate;
        const expectedType = !Array.isArray(predicate) && isIsMethodName(predicateFunction.name) ? methodTypeMap[predicateFunction.name] : 'predicate returns truthy for all values';
        throw new TypeError(typeErrorMessageMultipleValues(expectedType, values));
    }
}
function assertAny(predicate, ...values) {
    if (values.length === 0) {
        throw new TypeError('Invalid number of values');
    }
    if (!isAny(predicate, ...values)) {
        const predicates = Array.isArray(predicate) ? predicate : [predicate];
        const expectedTypes = predicates.map(singlePredicate => isIsMethodName(singlePredicate.name) ? methodTypeMap[singlePredicate.name] : 'predicate returns truthy for any value');
        throw new TypeError(typeErrorMessageMultipleValues(expectedTypes, values));
    }
}
function assertOptional(value, assertion, message) {
    if (!isUndefined(value)) {
        assertion(value, message);
    }
}
function assertArray(value, assertion, message) {
    if (!isArray(value)) {
        throw new TypeError(message ?? typeErrorMessage('Array', value));
    }
    if (assertion) {
        for (const element of value) {
            // @ts-expect-error: "Assertions require every name in the call target to be declared with an explicit type annotation."
            assertion(element, message);
        }
    }
}
function assertArrayBuffer(value, message) {
    if (!isArrayBuffer(value)) {
        throw new TypeError(message ?? typeErrorMessage('ArrayBuffer', value));
    }
}
function assertArrayLike(value, message) {
    if (!isArrayLike(value)) {
        throw new TypeError(message ?? typeErrorMessage('array-like', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function assertAsyncFunction(value, message) {
    if (!isAsyncFunction(value)) {
        throw new TypeError(message ?? typeErrorMessage('AsyncFunction', value));
    }
}
function assertAsyncGenerator(value, message) {
    if (!isAsyncGenerator(value)) {
        throw new TypeError(message ?? typeErrorMessage('AsyncGenerator', value));
    }
}
function assertAsyncGeneratorFunction(value, message) {
    if (!isAsyncGeneratorFunction(value)) {
        throw new TypeError(message ?? typeErrorMessage('AsyncGeneratorFunction', value));
    }
}
function assertAsyncIterable(value, message) {
    if (!isAsyncIterable(value)) {
        throw new TypeError(message ?? typeErrorMessage('AsyncIterable', value));
    }
}
function assertBigint(value, message) {
    if (!isBigint(value)) {
        throw new TypeError(message ?? typeErrorMessage('bigint', value));
    }
}
function assertBigInt64Array(value, message) {
    if (!isBigInt64Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('BigInt64Array', value));
    }
}
function assertBigUint64Array(value, message) {
    if (!isBigUint64Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('BigUint64Array', value));
    }
}
function assertBlob(value, message) {
    if (!isBlob(value)) {
        throw new TypeError(message ?? typeErrorMessage('Blob', value));
    }
}
function assertBoolean(value, message) {
    if (!isBoolean(value)) {
        throw new TypeError(message ?? typeErrorMessage('boolean', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function assertBoundFunction(value, message) {
    if (!isBoundFunction(value)) {
        throw new TypeError(message ?? typeErrorMessage('bound Function', value));
    }
}
/**
Note: [Prefer using `Uint8Array` instead of `Buffer`.](https://sindresorhus.com/blog/goodbye-nodejs-buffer)
*/
function assertBuffer(value, message) {
    if (!isBuffer(value)) {
        throw new TypeError(message ?? typeErrorMessage('Buffer', value));
    }
}
function assertClass(value, message) {
    if (!isClass(value)) {
        throw new TypeError(message ?? typeErrorMessage('Class', value));
    }
}
function assertDataView(value, message) {
    if (!isDataView(value)) {
        throw new TypeError(message ?? typeErrorMessage('DataView', value));
    }
}
function assertDate(value, message) {
    if (!isDate(value)) {
        throw new TypeError(message ?? typeErrorMessage('Date', value));
    }
}
function assertDirectInstanceOf(instance, class_, message) {
    if (!isDirectInstanceOf(instance, class_)) {
        throw new TypeError(message ?? typeErrorMessage('T', instance));
    }
}
function assertEmptyArray(value, message) {
    if (!isEmptyArray(value)) {
        throw new TypeError(message ?? typeErrorMessage('empty array', value));
    }
}
function assertEmptyMap(value, message) {
    if (!isEmptyMap(value)) {
        throw new TypeError(message ?? typeErrorMessage('empty map', value));
    }
}
function assertEmptyObject(value, message) {
    if (!isEmptyObject(value)) {
        throw new TypeError(message ?? typeErrorMessage('empty object', value));
    }
}
function assertEmptySet(value, message) {
    if (!isEmptySet(value)) {
        throw new TypeError(message ?? typeErrorMessage('empty set', value));
    }
}
function assertEmptyString(value, message) {
    if (!isEmptyString(value)) {
        throw new TypeError(message ?? typeErrorMessage('empty string', value));
    }
}
function assertEmptyStringOrWhitespace(value, message) {
    if (!isEmptyStringOrWhitespace(value)) {
        throw new TypeError(message ?? typeErrorMessage('empty string or whitespace', value));
    }
}
function assertEnumCase(value, targetEnum, message) {
    if (!isEnumCase(value, targetEnum)) {
        throw new TypeError(message ?? typeErrorMessage('EnumCase', value));
    }
}
function assertError(value, message) {
    if (!isError(value)) {
        throw new TypeError(message ?? typeErrorMessage('Error', value));
    }
}
function assertEvenInteger(value, message) {
    if (!isEvenInteger(value)) {
        throw new TypeError(message ?? typeErrorMessage('even integer', value));
    }
}
function assertFalsy(value, message) {
    if (!isFalsy(value)) {
        throw new TypeError(message ?? typeErrorMessage('falsy', value));
    }
}
function assertFiniteNumber(value, message) {
    if (!isFiniteNumber(value)) {
        throw new TypeError(message ?? typeErrorMessage('finite number', value));
    }
}
function assertFloat32Array(value, message) {
    if (!isFloat32Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('Float32Array', value));
    }
}
function assertFloat64Array(value, message) {
    if (!isFloat64Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('Float64Array', value));
    }
}
function assertFormData(value, message) {
    if (!isFormData(value)) {
        throw new TypeError(message ?? typeErrorMessage('FormData', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function assertFunction(value, message) {
    if (!isFunction(value)) {
        throw new TypeError(message ?? typeErrorMessage('Function', value));
    }
}
function assertGenerator(value, message) {
    if (!isGenerator(value)) {
        throw new TypeError(message ?? typeErrorMessage('Generator', value));
    }
}
function assertGeneratorFunction(value, message) {
    if (!isGeneratorFunction(value)) {
        throw new TypeError(message ?? typeErrorMessage('GeneratorFunction', value));
    }
}
function assertHtmlElement(value, message) {
    if (!isHtmlElement(value)) {
        throw new TypeError(message ?? typeErrorMessage('HTMLElement', value));
    }
}
function assertInfinite(value, message) {
    if (!isInfinite(value)) {
        throw new TypeError(message ?? typeErrorMessage('infinite number', value));
    }
}
function assertInRange(value, range, message) {
    if (!isInRange(value, range)) {
        throw new TypeError(message ?? typeErrorMessage('in range', value));
    }
}
function assertInt16Array(value, message) {
    if (!isInt16Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('Int16Array', value));
    }
}
function assertInt32Array(value, message) {
    if (!isInt32Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('Int32Array', value));
    }
}
function assertInt8Array(value, message) {
    if (!isInt8Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('Int8Array', value));
    }
}
function assertInteger(value, message) {
    if (!isInteger(value)) {
        throw new TypeError(message ?? typeErrorMessage('integer', value));
    }
}
function assertIterable(value, message) {
    if (!isIterable(value)) {
        throw new TypeError(message ?? typeErrorMessage('Iterable', value));
    }
}
function assertMap(value, message) {
    if (!isMap(value)) {
        throw new TypeError(message ?? typeErrorMessage('Map', value));
    }
}
function assertNan(value, message) {
    if (!isNan(value)) {
        throw new TypeError(message ?? typeErrorMessage('NaN', value));
    }
}
function assertNativePromise(value, message) {
    if (!isNativePromise(value)) {
        throw new TypeError(message ?? typeErrorMessage('native Promise', value));
    }
}
function assertNegativeInteger(value, message) {
    if (!isNegativeInteger(value)) {
        throw new TypeError(message ?? typeErrorMessage('negative integer', value));
    }
}
function assertNegativeNumber(value, message) {
    if (!isNegativeNumber(value)) {
        throw new TypeError(message ?? typeErrorMessage('negative number', value));
    }
}
function assertNodeStream(value, message) {
    if (!isNodeStream(value)) {
        throw new TypeError(message ?? typeErrorMessage('Node.js Stream', value));
    }
}
function assertNonEmptyArray(value, message) {
    if (!isNonEmptyArray(value)) {
        throw new TypeError(message ?? typeErrorMessage('non-empty array', value));
    }
}
function assertNonEmptyMap(value, message) {
    if (!isNonEmptyMap(value)) {
        throw new TypeError(message ?? typeErrorMessage('non-empty map', value));
    }
}
function assertNonEmptyObject(value, message) {
    if (!isNonEmptyObject(value)) {
        throw new TypeError(message ?? typeErrorMessage('non-empty object', value));
    }
}
function assertNonEmptySet(value, message) {
    if (!isNonEmptySet(value)) {
        throw new TypeError(message ?? typeErrorMessage('non-empty set', value));
    }
}
function assertNonEmptyString(value, message) {
    if (!isNonEmptyString(value)) {
        throw new TypeError(message ?? typeErrorMessage('non-empty string', value));
    }
}
function assertNonEmptyStringAndNotWhitespace(value, message) {
    if (!isNonEmptyStringAndNotWhitespace(value)) {
        throw new TypeError(message ?? typeErrorMessage('non-empty string and not whitespace', value));
    }
}
function assertNonNegativeInteger(value, message) {
    if (!isNonNegativeInteger(value)) {
        throw new TypeError(message ?? typeErrorMessage('non-negative integer', value));
    }
}
function assertNonNegativeNumber(value, message) {
    if (!isNonNegativeNumber(value)) {
        throw new TypeError(message ?? typeErrorMessage('non-negative number', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function assertNull(value, message) {
    if (!isNull(value)) {
        throw new TypeError(message ?? typeErrorMessage('null', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function assertNullOrUndefined(value, message) {
    if (!isNullOrUndefined(value)) {
        throw new TypeError(message ?? typeErrorMessage('null or undefined', value));
    }
}
function assertNumber(value, message) {
    if (!isNumber(value)) {
        throw new TypeError(message ?? typeErrorMessage('number', value));
    }
}
function assertNumericString(value, message) {
    if (!isNumericString(value)) {
        throw new TypeError(message ?? typeErrorMessage('string with a number', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function assertObject(value, message) {
    if (!isObject(value)) {
        throw new TypeError(message ?? typeErrorMessage('Object', value));
    }
}
function assertObservable(value, message) {
    if (!isObservable(value)) {
        throw new TypeError(message ?? typeErrorMessage('Observable', value));
    }
}
function assertOddInteger(value, message) {
    if (!isOddInteger(value)) {
        throw new TypeError(message ?? typeErrorMessage('odd integer', value));
    }
}
function assertPlainObject(value, message) {
    if (!isPlainObject(value)) {
        throw new TypeError(message ?? typeErrorMessage('plain object', value));
    }
}
function assertPositiveInteger(value, message) {
    if (!isPositiveInteger(value)) {
        throw new TypeError(message ?? typeErrorMessage('positive integer', value));
    }
}
function assertPositiveNumber(value, message) {
    if (!isPositiveNumber(value)) {
        throw new TypeError(message ?? typeErrorMessage('positive number', value));
    }
}
function assertPrimitive(value, message) {
    if (!isPrimitive(value)) {
        throw new TypeError(message ?? typeErrorMessage('primitive', value));
    }
}
function assertPromise(value, message) {
    if (!isPromise(value)) {
        throw new TypeError(message ?? typeErrorMessage('Promise', value));
    }
}
function assertPropertyKey(value, message) {
    if (!isPropertyKey(value)) {
        throw new TypeError(message ?? typeErrorMessage('PropertyKey', value));
    }
}
function assertRegExp(value, message) {
    if (!isRegExp(value)) {
        throw new TypeError(message ?? typeErrorMessage('RegExp', value));
    }
}
function assertSafeInteger(value, message) {
    if (!isSafeInteger(value)) {
        throw new TypeError(message ?? typeErrorMessage('safe integer', value));
    }
}
function assertSet(value, message) {
    if (!isSet(value)) {
        throw new TypeError(message ?? typeErrorMessage('Set', value));
    }
}
function assertSharedArrayBuffer(value, message) {
    if (!isSharedArrayBuffer(value)) {
        throw new TypeError(message ?? typeErrorMessage('SharedArrayBuffer', value));
    }
}
function assertString(value, message) {
    if (!isString(value)) {
        throw new TypeError(message ?? typeErrorMessage('string', value));
    }
}
function assertSymbol(value, message) {
    if (!isSymbol(value)) {
        throw new TypeError(message ?? typeErrorMessage('symbol', value));
    }
}
function assertTruthy(value, message) {
    if (!isTruthy(value)) {
        throw new TypeError(message ?? typeErrorMessage('truthy', value));
    }
}
function assertTupleLike(value, guards, message) {
    if (!isTupleLike(value, guards)) {
        throw new TypeError(message ?? typeErrorMessage('tuple-like', value));
    }
}
function assertTypedArray(value, message) {
    if (!isTypedArray(value)) {
        throw new TypeError(message ?? typeErrorMessage('TypedArray', value));
    }
}
function assertUint16Array(value, message) {
    if (!isUint16Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('Uint16Array', value));
    }
}
function assertUint32Array(value, message) {
    if (!isUint32Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('Uint32Array', value));
    }
}
function assertUint8Array(value, message) {
    if (!isUint8Array(value)) {
        throw new TypeError(message ?? typeErrorMessage('Uint8Array', value));
    }
}
function assertUint8ClampedArray(value, message) {
    if (!isUint8ClampedArray(value)) {
        throw new TypeError(message ?? typeErrorMessage('Uint8ClampedArray', value));
    }
}
function assertUndefined(value, message) {
    if (!isUndefined(value)) {
        throw new TypeError(message ?? typeErrorMessage('undefined', value));
    }
}
function assertUrlInstance(value, message) {
    if (!isUrlInstance(value)) {
        throw new TypeError(message ?? typeErrorMessage('URL', value));
    }
}
// eslint-disable-next-line unicorn/prevent-abbreviations
function assertUrlSearchParams(value, message) {
    if (!isUrlSearchParams(value)) {
        throw new TypeError(message ?? typeErrorMessage('URLSearchParams', value));
    }
}
function assertUrlString(value, message) {
    if (!isUrlString(value)) {
        throw new TypeError(message ?? typeErrorMessage('string with a URL', value));
    }
}
function assertValidDate(value, message) {
    if (!isValidDate(value)) {
        throw new TypeError(message ?? typeErrorMessage('valid Date', value));
    }
}
function assertValidLength(value, message) {
    if (!isValidLength(value)) {
        throw new TypeError(message ?? typeErrorMessage('valid length', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function assertWeakMap(value, message) {
    if (!isWeakMap(value)) {
        throw new TypeError(message ?? typeErrorMessage('WeakMap', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function assertWeakRef(value, message) {
    if (!isWeakRef(value)) {
        throw new TypeError(message ?? typeErrorMessage('WeakRef', value));
    }
}
// eslint-disable-next-line @typescript-eslint/no-restricted-types
function assertWeakSet(value, message) {
    if (!isWeakSet(value)) {
        throw new TypeError(message ?? typeErrorMessage('WeakSet', value));
    }
}
function assertWhitespaceString(value, message) {
    if (!isWhitespaceString(value)) {
        throw new TypeError(message ?? typeErrorMessage('whitespace string', value));
    }
}
/* harmony default export */ const distribution = (is);

// EXTERNAL MODULE: external "node:events"
var external_node_events_ = __webpack_require__(78474);
;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/strip-url-auth.js
/*
Returns the URL as a string with `username` and `password` stripped.
*/
function stripUrlAuth(url) {
    const sanitized = new URL(url);
    sanitized.username = '';
    sanitized.password = '';
    return sanitized.href;
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/errors.js


const normalizeError = (error) => {
    if (error instanceof globalThis.Error) {
        return error;
    }
    if (distribution.object(error)) {
        const errorLike = error;
        const message = typeof errorLike.message === 'string' ? errorLike.message : 'Non-error object thrown';
        const normalizedError = new globalThis.Error(message, { cause: error });
        if (typeof errorLike.stack === 'string') {
            normalizedError.stack = errorLike.stack;
        }
        if (typeof errorLike.code === 'string') {
            normalizedError.code = errorLike.code;
        }
        if (typeof errorLike.input === 'string') {
            normalizedError.input = errorLike.input;
        }
        return normalizedError;
    }
    return new globalThis.Error(String(error));
};
// A hacky check to prevent circular references.
function isRequest(x) {
    return distribution.object(x) && '_onResponse' in x;
}
/**
An error to be thrown when a request fails.
Contains a `code` property with error class code, like `ECONNREFUSED`.
*/
class RequestError extends Error {
    name = 'RequestError';
    code = 'ERR_GOT_REQUEST_ERROR';
    input;
    stack;
    response;
    request;
    timings;
    constructor(message, error, self, response) {
        super(message, { cause: error });
        // The stack is trimmed here so that the frames inside `got` do not appear in the trace the
        // caller sees. `unicorn/no-useless-error-capture-stack-trace` assumes the call is redundant
        // for a subclass of `Error`, which is not the case here.
        // eslint-disable-next-line unicorn/no-useless-error-capture-stack-trace
        Error.captureStackTrace(this, this.constructor);
        // The cause is kept as thrown, so it can be any value. Only an object can carry details.
        const errorLike = distribution.object(error) ? error : undefined;
        if (errorLike?.code) {
            this.code = errorLike.code;
        }
        this.input = errorLike?.input;
        if (isRequest(self)) {
            Object.defineProperties(this, {
                request: {
                    enumerable: false,
                    value: self,
                },
                response: {
                    enumerable: false,
                    value: response ?? self.response,
                },
            });
            this.options = self.options;
        }
        else {
            this.options = self;
        }
        this.timings = this.request?.timings;
        // Recover the original stacktrace
        if (distribution.string(errorLike?.stack) && distribution.string(this.stack)) {
            // Both stacks start with a `name: message` header, and both headers are rebuilt below
            // by dropping everything before this point. A multi-line message spans several lines,
            // so the whole message is the boundary. A message that is empty or absent matches at
            // zero and would leave the header in the frames, so the first newline is the boundary.
            // A message that is not in its stack, such as one changed after the stack was read, has no
            // boundary at all.
            const frameStart = (stack, message) => {
                if (!message) {
                    return stack.indexOf('\n');
                }
                const messageStart = stack.indexOf(message);
                return messageStart === -1 ? -1 : messageStart + message.length;
            };
            const headerEnd = frameStart(this.stack, this.message);
            const thisStackTrace = (headerEnd === -1 ? '' : this.stack.slice(headerEnd)).split('\n').toReversed();
            const causeStart = frameStart(errorLike.stack, errorLike.message);
            const originalStack = distribution.string(errorLike.message) && causeStart !== -1
                ? errorLike.stack.slice(causeStart)
                : `\n${errorLike.stack}`;
            const errorStackTrace = originalStack.split('\n').toReversed();
            // Remove duplicated traces
            while (errorStackTrace.length > 0 && errorStackTrace[0] === thisStackTrace[0]) {
                thisStackTrace.shift();
            }
            const frames = `${thisStackTrace.toReversed().join('\n')}${errorStackTrace.toReversed().join('\n')}`;
            let assignedStack;
            // A subclass sets `name` only after `super()` returns, so building the header here
            // would label every subclass as a plain `RequestError`. Read the names on access
            // instead, while still honouring an assigned stack the way `Error` does.
            Object.defineProperty(this, 'stack', {
                configurable: true,
                enumerable: false,
                get: () => assignedStack ?? `${this.name}: ${this.message}${frames}`,
                set(value) {
                    assignedStack = distribution.string(value) ? value : undefined;
                },
            });
        }
    }
}
/**
An error to be thrown when the server redirects you more than ten times.
Includes a `response` property.
*/
class MaxRedirectsError extends RequestError {
    name = 'MaxRedirectsError';
    code = 'ERR_TOO_MANY_REDIRECTS';
    constructor(request) {
        super(`Redirected ${request.options.maxRedirects} times. Aborting.`, {}, request);
    }
}
/**
An error to be thrown when the server response code is not 2xx nor 3xx if `options.followRedirect` is `true`, but always except for 304.
Includes a `response` property.
*/
// eslint-disable-next-line @typescript-eslint/naming-convention
class HTTPError extends RequestError {
    name = 'HTTPError';
    code = 'ERR_NON_2XX_3XX_RESPONSE';
    constructor(response) {
        super(`Request failed with status code ${response.statusCode} (${response.statusMessage}): ${response.request.options.method} ${stripUrlAuth(response.request.options.url)}`, {}, response.request, response);
    }
}
/**
An error to be thrown when a cache method fails.
For example, if the database goes down or there's a filesystem error.
*/
class CacheError extends RequestError {
    name = 'CacheError';
    code = 'ERR_CACHE_ACCESS';
    constructor(error, request) {
        super(error.message, error, request);
    }
}
/**
An error to be thrown when the request body is a stream and an error occurs while reading from that stream.
*/
class UploadError extends RequestError {
    name = 'UploadError';
    code = 'ERR_UPLOAD';
    constructor(error, request) {
        super(error.message, error, request);
    }
}
/**
An error to be thrown when the request is aborted due to a timeout.
Includes an `event` and `timings` property.
*/
class TimeoutError extends RequestError {
    name = 'TimeoutError';
    code = 'ETIMEDOUT';
    timings;
    event;
    constructor(error, timings, request) {
        super(error.message, error, request);
        // `AbortSignal.timeout()` reports a `DOMException`, which names no phase.
        this.event = error.event ?? 'request';
        this.timings = timings;
    }
}
/**
An error to be thrown when reading from response stream fails.
*/
class ReadError extends RequestError {
    name = 'ReadError';
    code = 'ERR_READING_RESPONSE_STREAM';
    constructor(error, request) {
        super(error.message, error, request);
        if (error.code === 'ECONNRESET' || error.code === 'ERR_HTTP_CONTENT_LENGTH_MISMATCH') {
            this.code = error.code;
        }
    }
}
/**
An error which always triggers a new retry when thrown.
*/
class RetryError extends RequestError {
    name = 'RetryError';
    code = 'ERR_RETRYING';
    constructor(request) {
        super('Retrying', {}, request);
    }
}
/**
An error to be thrown when the request is aborted by AbortController.
*/
class AbortError extends RequestError {
    name = 'AbortError';
    code = 'ERR_ABORTED';
    constructor(request) {
        super('This operation was aborted.', {}, request);
        if (request.options?.signal?.aborted) {
            this.cause = request.options.signal.reason;
        }
    }
}

// EXTERNAL MODULE: external "node:process"
var external_node_process_ = __webpack_require__(1708);
// EXTERNAL MODULE: external "node:buffer"
var external_node_buffer_ = __webpack_require__(4573);
// EXTERNAL MODULE: external "node:stream"
var external_node_stream_ = __webpack_require__(57075);
// EXTERNAL MODULE: external "node:http"
var external_node_http_ = __webpack_require__(37067);
// EXTERNAL MODULE: external "node:http2"
var external_node_http2_ = __webpack_require__(32467);
;// CONCATENATED MODULE: ./node_modules/byte-counter/utilities.js
const textEncoder = new TextEncoder();

function byteLength(data) {
	if (typeof data === 'string') {
		return textEncoder.encode(data).byteLength;
	}

	if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
		return data.byteLength;
	}

	return 0;
}

;// CONCATENATED MODULE: ./node_modules/chunk-data/index.js
const toUint8Array = data => (data instanceof Uint8Array
	? data
	: new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

function * chunk(data, chunkSize) {
	if (!ArrayBuffer.isView(data)) {
		throw new TypeError('Expected data to be ArrayBufferView');
	}

	if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
		throw new TypeError('Expected chunkSize to be a positive integer');
	}

	const uint8Array = toUint8Array(data);

	for (let offset = 0; offset < uint8Array.length; offset += chunkSize) {
		yield uint8Array.subarray(offset, offset + chunkSize);
	}
}

function * chunkFrom(iterable, chunkSize) {
	if (typeof iterable?.[Symbol.iterator] !== 'function' || typeof iterable === 'string') {
		throw new TypeError('Expected iterable to be an Iterable<ArrayBufferView>');
	}

	if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
		throw new TypeError('Expected chunkSize to be a positive integer');
	}

	let carryBuffer;
	let carryLength = 0;

	for (const part of iterable) {
		if (!ArrayBuffer.isView(part)) {
			throw new TypeError('Expected iterable chunks to be Uint8Array or ArrayBufferView');
		}

		const buffer = toUint8Array(part);

		// Skip empty buffers
		if (buffer.length === 0) {
			continue;
		}

		let offset = 0;

		// Fill carry buffer to a full chunk if present
		if (carryLength > 0) {
			const needed = chunkSize - carryLength;
			if (buffer.length >= needed) {
				// Complete the chunk: merge carry + needed bytes from buffer
				const out = new Uint8Array(chunkSize);
				out.set(carryBuffer.subarray(0, carryLength), 0);
				out.set(buffer.subarray(0, needed), carryLength);
				yield out;
				carryLength = 0;
				offset = needed;
			} else {
				// Accumulate into fixed carry buffer (avoids O(n²) from repeated reallocations)
				// Safe: buffer.length < needed implies carryLength + buffer.length < chunkSize
				carryBuffer.set(buffer, carryLength);
				carryLength += buffer.length;
				continue;
			}
		}

		// Emit direct slices from current buffer
		for (; offset + chunkSize <= buffer.length; offset += chunkSize) {
			yield buffer.subarray(offset, offset + chunkSize);
		}

		// Save remainder in carry buffer
		if (offset < buffer.length) {
			carryBuffer ||= new Uint8Array(chunkSize);

			const remainder = buffer.length - offset;
			carryBuffer.set(buffer.subarray(offset), 0);
			carryLength = remainder;
		}
	}

	if (carryLength > 0) {
		yield carryBuffer.subarray(0, carryLength);
	}
}

async function * chunkFromAsync(iterable, chunkSize) {
	if (typeof iterable?.[Symbol.asyncIterator] !== 'function' && typeof iterable?.[Symbol.iterator] !== 'function') {
		throw new TypeError('Expected iterable to be an async iterable or iterable');
	}

	if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
		throw new TypeError('Expected chunkSize to be a positive integer');
	}

	let carryBuffer;
	let carryLength = 0;

	for await (const part of iterable) {
		if (!ArrayBuffer.isView(part)) {
			throw new TypeError('Expected iterable chunks to be Uint8Array or ArrayBufferView');
		}

		const buffer = toUint8Array(part);

		// Skip empty buffers
		if (buffer.length === 0) {
			continue;
		}

		let offset = 0;

		// Fill carry buffer to a full chunk if present
		if (carryLength > 0) {
			const needed = chunkSize - carryLength;
			if (buffer.length >= needed) {
				// Complete the chunk: merge carry + needed bytes from buffer
				const out = new Uint8Array(chunkSize);
				out.set(carryBuffer.subarray(0, carryLength), 0);
				out.set(buffer.subarray(0, needed), carryLength);
				yield out;
				carryLength = 0;
				offset = needed;
			} else {
				// Accumulate into fixed carry buffer (avoids O(n²) from repeated reallocations)
				// Safe: buffer.length < needed implies carryLength + buffer.length < chunkSize
				carryBuffer.set(buffer, carryLength);
				carryLength += buffer.length;
				continue;
			}
		}

		// Emit direct slices from current buffer
		for (; offset + chunkSize <= buffer.length; offset += chunkSize) {
			yield buffer.subarray(offset, offset + chunkSize);
		}

		// Save remainder in carry buffer
		if (offset < buffer.length) {
			carryBuffer ||= new Uint8Array(chunkSize);

			const remainder = buffer.length - offset;
			carryBuffer.set(buffer.subarray(offset), 0);
			carryLength = remainder;
		}
	}

	if (carryLength > 0) {
		yield carryBuffer.subarray(0, carryLength);
	}
}

;// CONCATENATED MODULE: ./node_modules/uint8array-extras/index.js
const objectToString = Object.prototype.toString;
const uint8ArrayStringified = '[object Uint8Array]';
const arrayBufferStringified = '[object ArrayBuffer]';

function isType(value, typeConstructor, typeStringified) {
	if (!value) {
		return false;
	}

	if (value.constructor === typeConstructor) {
		return true;
	}

	return objectToString.call(value) === typeStringified;
}

function uint8array_extras_isUint8Array(value) {
	return isType(value, Uint8Array, uint8ArrayStringified);
}

function uint8array_extras_isArrayBuffer(value) {
	return isType(value, ArrayBuffer, arrayBufferStringified);
}

function isUint8ArrayOrArrayBuffer(value) {
	return uint8array_extras_isUint8Array(value) || uint8array_extras_isArrayBuffer(value);
}

function toUint8ArrayIfArrayBuffer(value) {
	return uint8array_extras_isArrayBuffer(value) ? new Uint8Array(value) : value;
}

function uint8array_extras_assertUint8Array(value) {
	if (!uint8array_extras_isUint8Array(value)) {
		throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof value}\``);
	}
}

function assertUint8ArrayOrArrayBuffer(value) {
	if (!isUint8ArrayOrArrayBuffer(value)) {
		throw new TypeError(`Expected \`Uint8Array\` or \`ArrayBuffer\`, got \`${typeof value}\``);
	}
}

function uint8array_extras_toUint8Array(value) {
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}

	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}

	throw new TypeError(`Unsupported value, got \`${typeof value}\`.`);
}

function concatUint8Arrays(arrays, totalLength) {
	if (arrays.length === 0) {
		return new Uint8Array(0);
	}

	totalLength ??= arrays.reduce((accumulator, currentValue) => accumulator + currentValue.byteLength, 0);

	const returnValue = new Uint8Array(totalLength);

	let offset = 0;
	for (let array of arrays) {
		assertUint8ArrayOrArrayBuffer(array);
		array = toUint8ArrayIfArrayBuffer(array);
		returnValue.set(array, offset);
		offset += array.length;
	}

	return returnValue;
}

function areUint8ArraysEqual(a, b) {
	assertUint8ArrayOrArrayBuffer(a);
	assertUint8ArrayOrArrayBuffer(b);
	a = toUint8ArrayIfArrayBuffer(a);
	b = toUint8ArrayIfArrayBuffer(b);

	if (a === b) {
		return true;
	}

	if (a.length !== b.length) {
		return false;
	}

	// eslint-disable-next-line unicorn/no-for-loop
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) {
			return false;
		}
	}

	return true;
}

function compareUint8Arrays(a, b) {
	assertUint8ArrayOrArrayBuffer(a);
	assertUint8ArrayOrArrayBuffer(b);
	a = toUint8ArrayIfArrayBuffer(a);
	b = toUint8ArrayIfArrayBuffer(b);

	const length = Math.min(a.length, b.length);

	for (let index = 0; index < length; index++) {
		const diff = a[index] - b[index];
		if (diff !== 0) {
			return Math.sign(diff);
		}
	}

	// At this point, all the compared elements are equal.
	// The shorter array should come first if the arrays are of different lengths.
	return Math.sign(a.length - b.length);
}

const cachedDecoders = {
	utf8: new globalThis.TextDecoder('utf8'),
};

function uint8ArrayToString(array, encoding = 'utf8') {
	assertUint8ArrayOrArrayBuffer(array);
	cachedDecoders[encoding] ??= new globalThis.TextDecoder(encoding);
	return cachedDecoders[encoding].decode(array);
}

function uint8array_extras_assertString(value) {
	if (typeof value !== 'string') {
		throw new TypeError(`Expected \`string\`, got \`${typeof value}\``);
	}
}

const cachedEncoder = new globalThis.TextEncoder();

function stringToUint8Array(string) {
	uint8array_extras_assertString(string);
	return cachedEncoder.encode(string);
}

function base64ToBase64Url(base64) {
	return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBase64(base64url) {
	const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/');
	const padding = (4 - (base64.length % 4)) % 4;
	return base64 + '='.repeat(padding);
}

// Reference: https://phuoc.ng/collection/this-vs-that/concat-vs-push/
// Important: Keep this value divisible by 3 so intermediate chunks produce no Base64 padding.
const MAX_BLOCK_SIZE = 65_535;

function uint8ArrayToBase64(array, {urlSafe = false} = {}) {
	assertUint8ArrayOrArrayBuffer(array);
	array = toUint8ArrayIfArrayBuffer(array);

	let base64 = '';

	for (let index = 0; index < array.length; index += MAX_BLOCK_SIZE) {
		const chunk = array.subarray(index, index + MAX_BLOCK_SIZE);
		// Required as `btoa` and `atob` don't properly support Unicode: https://developer.mozilla.org/en-US/docs/Glossary/Base64#the_unicode_problem
		base64 += globalThis.btoa(String.fromCodePoint.apply(undefined, chunk));
	}

	return urlSafe ? base64ToBase64Url(base64) : base64;
}

function base64ToUint8Array(base64String) {
	uint8array_extras_assertString(base64String);
	return Uint8Array.from(globalThis.atob(base64UrlToBase64(base64String)), x => x.codePointAt(0));
}

function stringToBase64(string, {urlSafe = false} = {}) {
	uint8array_extras_assertString(string);
	return uint8ArrayToBase64(stringToUint8Array(string), {urlSafe});
}

function base64ToString(base64String) {
	uint8array_extras_assertString(base64String);
	return uint8ArrayToString(base64ToUint8Array(base64String));
}

const byteToHexLookupTable = Array.from({length: 256}, (_, index) => index.toString(16).padStart(2, '0'));

function uint8ArrayToHex(array) {
	assertUint8ArrayOrArrayBuffer(array);
	array = toUint8ArrayIfArrayBuffer(array);

	// Concatenating a string is faster than using an array.
	let hexString = '';

	// eslint-disable-next-line unicorn/no-for-loop -- Max performance is critical.
	for (let index = 0; index < array.length; index++) {
		hexString += byteToHexLookupTable[array[index]];
	}

	return hexString;
}

const hexToDecimalLookupTable = {
	0: 0,
	1: 1,
	2: 2,
	3: 3,
	4: 4,
	5: 5,
	6: 6,
	7: 7,
	8: 8,
	9: 9,
	a: 10,
	b: 11,
	c: 12,
	d: 13,
	e: 14,
	f: 15,
	A: 10,
	B: 11,
	C: 12,
	D: 13,
	E: 14,
	F: 15,
};

function hexToUint8Array(hexString) {
	uint8array_extras_assertString(hexString);

	if (hexString.length % 2 !== 0) {
		throw new Error('Invalid Hex string length.');
	}

	const resultLength = hexString.length / 2;
	const bytes = new Uint8Array(resultLength);

	for (let index = 0; index < resultLength; index++) {
		const highNibble = hexToDecimalLookupTable[hexString[index * 2]];
		const lowNibble = hexToDecimalLookupTable[hexString[(index * 2) + 1]];

		if (highNibble === undefined || lowNibble === undefined) {
			throw new Error(`Invalid Hex character encountered at position ${index * 2}`);
		}

		bytes[index] = (highNibble << 4) | lowNibble; // eslint-disable-line no-bitwise
	}

	return bytes;
}

/**
@param {DataView} view
@returns {number}
*/
function getUintBE(view) {
	const {byteLength} = view;

	if (byteLength === 6) {
		return (view.getUint16(0) * (2 ** 32)) + view.getUint32(2);
	}

	if (byteLength === 5) {
		return (view.getUint8(0) * (2 ** 32)) + view.getUint32(1);
	}

	if (byteLength === 4) {
		return view.getUint32(0);
	}

	if (byteLength === 3) {
		return (view.getUint8(0) * (2 ** 16)) + view.getUint16(1);
	}

	if (byteLength === 2) {
		return view.getUint16(0);
	}

	if (byteLength === 1) {
		return view.getUint8(0);
	}
}

/**
@param {Uint8Array | ArrayBuffer} array
@param {Uint8Array | ArrayBuffer} value
@returns {number}
*/
function indexOf(array, value) {
	array = toUint8ArrayIfArrayBuffer(array);
	value = toUint8ArrayIfArrayBuffer(value);

	const arrayLength = array.length;
	const valueLength = value.length;

	if (valueLength === 0) {
		return -1;
	}

	if (valueLength > arrayLength) {
		return -1;
	}

	const validOffsetLength = arrayLength - valueLength;

	for (let index = 0; index <= validOffsetLength; index++) {
		let isMatch = true;
		for (let index2 = 0; index2 < valueLength; index2++) {
			if (array[index + index2] !== value[index2]) {
				isMatch = false;
				break;
			}
		}

		if (isMatch) {
			return index;
		}
	}

	return -1;
}

/**
@param {Uint8Array | ArrayBuffer} array
@param {Uint8Array | ArrayBuffer} value
@returns {boolean}
*/
function includes(array, value) {
	return indexOf(array, value) !== -1;
}

// EXTERNAL MODULE: external "node:crypto"
var external_node_crypto_ = __webpack_require__(77598);
// EXTERNAL MODULE: external "node:url"
var external_node_url_ = __webpack_require__(73136);
;// CONCATENATED MODULE: ./node_modules/get-stream/node_modules/is-stream/index.js
function isStream(stream, {checkOpen = true} = {}) {
	return stream !== null
		&& typeof stream === 'object'
		&& (stream.writable || stream.readable || !checkOpen || (stream.writable === undefined && stream.readable === undefined))
		&& typeof stream.pipe === 'function';
}

function isWritableStream(stream, {checkOpen = true} = {}) {
	return isStream(stream, {checkOpen})
		&& (stream.writable || !checkOpen)
		&& typeof stream.write === 'function'
		&& typeof stream.end === 'function'
		&& typeof stream.writable === 'boolean'
		&& typeof stream.writableObjectMode === 'boolean'
		&& typeof stream.destroy === 'function'
		&& typeof stream.destroyed === 'boolean';
}

function isReadableStream(stream, {checkOpen = true} = {}) {
	return isStream(stream, {checkOpen})
		&& (stream.readable || !checkOpen)
		&& typeof stream.read === 'function'
		&& typeof stream.readable === 'boolean'
		&& typeof stream.readableObjectMode === 'boolean'
		&& typeof stream.destroy === 'function'
		&& typeof stream.destroyed === 'boolean';
}

function isDuplexStream(stream, options) {
	return isWritableStream(stream, options)
		&& isReadableStream(stream, options);
}

function isTransformStream(stream, options) {
	return isDuplexStream(stream, options)
		&& typeof stream._transform === 'function';
}

;// CONCATENATED MODULE: ./node_modules/@sec-ant/readable-stream/dist/ponyfill/asyncIterator.js
const a = Object.getPrototypeOf(
  Object.getPrototypeOf(
    /* istanbul ignore next */
    async function* () {
    }
  ).prototype
);
class c {
  #t;
  #n;
  #r = !1;
  #e = void 0;
  constructor(e, t) {
    this.#t = e, this.#n = t;
  }
  next() {
    const e = () => this.#s();
    return this.#e = this.#e ? this.#e.then(e, e) : e(), this.#e;
  }
  return(e) {
    const t = () => this.#i(e);
    return this.#e ? this.#e.then(t, t) : t();
  }
  async #s() {
    if (this.#r)
      return {
        done: !0,
        value: void 0
      };
    let e;
    try {
      e = await this.#t.read();
    } catch (t) {
      throw this.#e = void 0, this.#r = !0, this.#t.releaseLock(), t;
    }
    return e.done && (this.#e = void 0, this.#r = !0, this.#t.releaseLock()), e;
  }
  async #i(e) {
    if (this.#r)
      return {
        done: !0,
        value: e
      };
    if (this.#r = !0, !this.#n) {
      const t = this.#t.cancel(e);
      return this.#t.releaseLock(), await t, {
        done: !0,
        value: e
      };
    }
    return this.#t.releaseLock(), {
      done: !0,
      value: e
    };
  }
}
const n = Symbol();
function i() {
  return this[n].next();
}
Object.defineProperty(i, "name", { value: "next" });
function o(r) {
  return this[n].return(r);
}
Object.defineProperty(o, "name", { value: "return" });
const u = Object.create(a, {
  next: {
    enumerable: !0,
    configurable: !0,
    writable: !0,
    value: i
  },
  return: {
    enumerable: !0,
    configurable: !0,
    writable: !0,
    value: o
  }
});
function h({ preventCancel: r = !1 } = {}) {
  const e = this.getReader(), t = new c(
    e,
    r
  ), s = Object.create(u);
  return s[n] = t, s;
}


;// CONCATENATED MODULE: ./node_modules/@sec-ant/readable-stream/dist/ponyfill/index.js




;// CONCATENATED MODULE: ./node_modules/get-stream/source/stream.js



const getAsyncIterable = stream => {
	if (isReadableStream(stream, {checkOpen: false}) && nodeImports.on !== undefined) {
		return getStreamIterable(stream);
	}

	if (typeof stream?.[Symbol.asyncIterator] === 'function') {
		return stream;
	}

	// `ReadableStream[Symbol.asyncIterator]` support is missing in multiple browsers, so we ponyfill it
	if (stream_toString.call(stream) === '[object ReadableStream]') {
		return h.call(stream);
	}

	throw new TypeError('The first argument must be a Readable, a ReadableStream, or an async iterable.');
};

const {toString: stream_toString} = Object.prototype;

// The default iterable for Node.js streams does not allow for multiple readers at once, so we re-implement it
const getStreamIterable = async function * (stream) {
	const controller = new AbortController();
	const state = {};
	handleStreamEnd(stream, controller, state);

	try {
		for await (const [chunk] of nodeImports.on(stream, 'data', {signal: controller.signal})) {
			yield chunk;
		}
	} catch (error) {
		// Stream failure, for example due to `stream.destroy(error)`
		if (state.error !== undefined) {
			throw state.error;
		// `error` event directly emitted on stream
		} else if (!controller.signal.aborted) {
			throw error;
		// Otherwise, stream completed successfully
		}
		// The `finally` block also runs when the caller throws, for example due to the `maxBuffer` option
	} finally {
		stream.destroy();
	}
};

const handleStreamEnd = async (stream, controller, state) => {
	try {
		await nodeImports.finished(stream, {
			cleanup: true,
			readable: true,
			writable: false,
			error: false,
		});
	} catch (error) {
		state.error = error;
	} finally {
		controller.abort();
	}
};

// Loaded by the Node entrypoint, but not by the browser one.
// This prevents using dynamic imports.
const nodeImports = {};

;// CONCATENATED MODULE: ./node_modules/get-stream/source/contents.js


const getStreamContents = async (stream, {init, convertChunk, getSize, truncateChunk, addChunk, getFinalChunk, finalize}, {maxBuffer = Number.POSITIVE_INFINITY} = {}) => {
	const asyncIterable = getAsyncIterable(stream);

	const state = init();
	state.length = 0;

	try {
		for await (const chunk of asyncIterable) {
			const chunkType = getChunkType(chunk);
			const convertedChunk = convertChunk[chunkType](chunk, state);
			appendChunk({
				convertedChunk,
				state,
				getSize,
				truncateChunk,
				addChunk,
				maxBuffer,
			});
		}

		appendFinalChunk({
			state,
			convertChunk,
			getSize,
			truncateChunk,
			addChunk,
			getFinalChunk,
			maxBuffer,
		});
		return finalize(state);
	} catch (error) {
		const normalizedError = typeof error === 'object' && error !== null ? error : new Error(error);
		normalizedError.bufferedData = finalize(state);
		throw normalizedError;
	}
};

const appendFinalChunk = ({state, getSize, truncateChunk, addChunk, getFinalChunk, maxBuffer}) => {
	const convertedChunk = getFinalChunk(state);
	if (convertedChunk !== undefined) {
		appendChunk({
			convertedChunk,
			state,
			getSize,
			truncateChunk,
			addChunk,
			maxBuffer,
		});
	}
};

const appendChunk = ({convertedChunk, state, getSize, truncateChunk, addChunk, maxBuffer}) => {
	const chunkSize = getSize(convertedChunk);
	const newLength = state.length + chunkSize;

	if (newLength <= maxBuffer) {
		addNewChunk(convertedChunk, state, addChunk, newLength);
		return;
	}

	const truncatedChunk = truncateChunk(convertedChunk, maxBuffer - state.length);

	if (truncatedChunk !== undefined) {
		addNewChunk(truncatedChunk, state, addChunk, maxBuffer);
	}

	throw new MaxBufferError();
};

const addNewChunk = (convertedChunk, state, addChunk, newLength) => {
	state.contents = addChunk(convertedChunk, state, newLength);
	state.length = newLength;
};

const getChunkType = chunk => {
	const typeOfChunk = typeof chunk;

	if (typeOfChunk === 'string') {
		return 'string';
	}

	if (typeOfChunk !== 'object' || chunk === null) {
		return 'others';
	}

	if (globalThis.Buffer?.isBuffer(chunk)) {
		return 'buffer';
	}

	const prototypeName = contents_objectToString.call(chunk);

	if (prototypeName === '[object ArrayBuffer]') {
		return 'arrayBuffer';
	}

	if (prototypeName === '[object DataView]') {
		return 'dataView';
	}

	if (
		Number.isInteger(chunk.byteLength)
		&& Number.isInteger(chunk.byteOffset)
		&& contents_objectToString.call(chunk.buffer) === '[object ArrayBuffer]'
	) {
		return 'typedArray';
	}

	return 'others';
};

const {toString: contents_objectToString} = Object.prototype;

class MaxBufferError extends Error {
	name = 'MaxBufferError';

	constructor() {
		super('maxBuffer exceeded');
	}
}

;// CONCATENATED MODULE: ./node_modules/get-stream/source/utils.js
const identity = value => value;

const noop = () => undefined;

const getContentsProperty = ({contents}) => contents;

const throwObjectStream = chunk => {
	throw new Error(`Streams in object mode are not supported: ${String(chunk)}`);
};

const getLengthProperty = convertedChunk => convertedChunk.length;

;// CONCATENATED MODULE: ./node_modules/get-stream/source/array-buffer.js



async function getStreamAsArrayBuffer(stream, options) {
	return getStreamContents(stream, arrayBufferMethods, options);
}

const initArrayBuffer = () => ({contents: new ArrayBuffer(0)});

const useTextEncoder = chunk => array_buffer_textEncoder.encode(chunk);
const array_buffer_textEncoder = new TextEncoder();

const useUint8Array = chunk => new Uint8Array(chunk);

const useUint8ArrayWithOffset = chunk => new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

const truncateArrayBufferChunk = (convertedChunk, chunkSize) => convertedChunk.slice(0, chunkSize);

// `contents` is an increasingly growing `Uint8Array`.
const addArrayBufferChunk = (convertedChunk, {contents, length: previousLength}, length) => {
	const newContents = hasArrayBufferResize() ? resizeArrayBuffer(contents, length) : resizeArrayBufferSlow(contents, length);
	new Uint8Array(newContents).set(convertedChunk, previousLength);
	return newContents;
};

// Without `ArrayBuffer.resize()`, `contents` size is always a power of 2.
// This means its last bytes are zeroes (not stream data), which need to be
// trimmed at the end with `ArrayBuffer.slice()`.
const resizeArrayBufferSlow = (contents, length) => {
	if (length <= contents.byteLength) {
		return contents;
	}

	const arrayBuffer = new ArrayBuffer(getNewContentsLength(length));
	new Uint8Array(arrayBuffer).set(new Uint8Array(contents), 0);
	return arrayBuffer;
};

// With `ArrayBuffer.resize()`, `contents` size matches exactly the size of
// the stream data. It does not include extraneous zeroes to trim at the end.
// The underlying `ArrayBuffer` does allocate a number of bytes that is a power
// of 2, but those bytes are only visible after calling `ArrayBuffer.resize()`.
const resizeArrayBuffer = (contents, length) => {
	if (length <= contents.maxByteLength) {
		contents.resize(length);
		return contents;
	}

	const arrayBuffer = new ArrayBuffer(length, {maxByteLength: getNewContentsLength(length)});
	new Uint8Array(arrayBuffer).set(new Uint8Array(contents), 0);
	return arrayBuffer;
};

// Retrieve the closest `length` that is both >= and a power of 2
const getNewContentsLength = length => SCALE_FACTOR ** Math.ceil(Math.log(length) / Math.log(SCALE_FACTOR));

const SCALE_FACTOR = 2;

const finalizeArrayBuffer = ({contents, length}) => hasArrayBufferResize() ? contents : contents.slice(0, length);

// `ArrayBuffer.slice()` is slow. When `ArrayBuffer.resize()` is available
// (Node >=20.0.0, Safari >=16.4 and Chrome), we can use it instead.
// eslint-disable-next-line no-warning-comments
// TODO: remove after dropping support for Node 20.
// eslint-disable-next-line no-warning-comments
// TODO: use `ArrayBuffer.transferToFixedLength()` instead once it is available
const hasArrayBufferResize = () => 'resize' in ArrayBuffer.prototype;

const arrayBufferMethods = {
	init: initArrayBuffer,
	convertChunk: {
		string: useTextEncoder,
		buffer: useUint8Array,
		arrayBuffer: useUint8Array,
		dataView: useUint8ArrayWithOffset,
		typedArray: useUint8ArrayWithOffset,
		others: throwObjectStream,
	},
	getSize: getLengthProperty,
	truncateChunk: truncateArrayBufferChunk,
	addChunk: addArrayBufferChunk,
	getFinalChunk: noop,
	finalize: finalizeArrayBuffer,
};

;// CONCATENATED MODULE: ./node_modules/get-stream/source/buffer.js


async function getStreamAsBuffer(stream, options) {
	if (!('Buffer' in globalThis)) {
		throw new Error('getStreamAsBuffer() is only supported in Node.js');
	}

	try {
		return arrayBufferToNodeBuffer(await getStreamAsArrayBuffer(stream, options));
	} catch (error) {
		if (error.bufferedData !== undefined) {
			error.bufferedData = arrayBufferToNodeBuffer(error.bufferedData);
		}

		throw error;
	}
}

const arrayBufferToNodeBuffer = arrayBuffer => globalThis.Buffer.from(arrayBuffer);

// EXTERNAL MODULE: ./node_modules/http-cache-semantics/index.js
var http_cache_semantics = __webpack_require__(12203);
// EXTERNAL MODULE: external "buffer"
var external_buffer_ = __webpack_require__(20181);
;// CONCATENATED MODULE: ./node_modules/@keyv/serialize/dist/index.js
// src/index.ts

var _serialize = (data, escapeColonStrings = true) => {
  if (data === void 0 || data === null) {
    return "null";
  }
  if (typeof data === "string") {
    return JSON.stringify(
      escapeColonStrings && data.startsWith(":") ? `:${data}` : data
    );
  }
  if (external_buffer_.Buffer.isBuffer(data)) {
    return JSON.stringify(`:base64:${data.toString("base64")}`);
  }
  if (data?.toJSON) {
    data = data.toJSON();
  }
  if (typeof data === "object") {
    let s = "";
    const array = Array.isArray(data);
    s = array ? "[" : "{";
    let first = true;
    for (const k in data) {
      const ignore = typeof data[k] === "function" || !array && data[k] === void 0;
      if (!Object.hasOwn(data, k) || ignore) {
        continue;
      }
      if (!first) {
        s += ",";
      }
      first = false;
      if (array) {
        s += _serialize(data[k], escapeColonStrings);
      } else if (data[k] !== void 0) {
        s += `${_serialize(k, false)}:${_serialize(data[k], escapeColonStrings)}`;
      }
    }
    s += array ? "]" : "}";
    return s;
  }
  return JSON.stringify(data);
};
var defaultSerialize = (data) => {
  return _serialize(data, true);
};
var defaultDeserialize = (data) => JSON.parse(data, (_, value) => {
  if (typeof value === "string") {
    if (value.startsWith(":base64:")) {
      return external_buffer_.Buffer.from(value.slice(8), "base64");
    }
    return value.startsWith(":") ? value.slice(1) : value;
  }
  return value;
});


;// CONCATENATED MODULE: ./node_modules/cacheable-request/node_modules/keyv/dist/index.js
// src/index.ts


// src/event-manager.ts
var EventManager = class {
  _eventListeners;
  _maxListeners;
  constructor() {
    this._eventListeners = /* @__PURE__ */ new Map();
    this._maxListeners = 100;
  }
  maxListeners() {
    return this._maxListeners;
  }
  // Add an event listener
  addListener(event, listener) {
    this.on(event, listener);
  }
  on(event, listener) {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, []);
    }
    const listeners = this._eventListeners.get(event);
    if (listeners) {
      if (listeners.length >= this._maxListeners) {
        console.warn(
          `MaxListenersExceededWarning: Possible event memory leak detected. ${listeners.length + 1} ${event} listeners added. Use setMaxListeners() to increase limit.`
        );
      }
      listeners.push(listener);
    }
    return this;
  }
  // Remove an event listener
  removeListener(event, listener) {
    this.off(event, listener);
  }
  off(event, listener) {
    const listeners = this._eventListeners.get(event) ?? [];
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
    if (listeners.length === 0) {
      this._eventListeners.delete(event);
    }
  }
  once(event, listener) {
    const onceListener = (...arguments_) => {
      listener(...arguments_);
      this.off(event, onceListener);
    };
    this.on(event, onceListener);
  }
  // Emit an event
  // biome-ignore lint/suspicious/noExplicitAny: type format
  emit(event, ...arguments_) {
    const listeners = this._eventListeners.get(event);
    if (listeners && listeners.length > 0) {
      for (const listener of listeners) {
        listener(...arguments_);
      }
    }
  }
  // Get all listeners for a specific event
  listeners(event) {
    return this._eventListeners.get(event) ?? [];
  }
  // Remove all listeners for a specific event
  removeAllListeners(event) {
    if (event) {
      this._eventListeners.delete(event);
    } else {
      this._eventListeners.clear();
    }
  }
  // Set the maximum number of listeners for a single event
  setMaxListeners(n) {
    this._maxListeners = n;
  }
};
var event_manager_default = EventManager;

// src/hooks-manager.ts
var HooksManager = class extends event_manager_default {
  _hookHandlers;
  constructor() {
    super();
    this._hookHandlers = /* @__PURE__ */ new Map();
  }
  // Adds a handler function for a specific event
  addHandler(event, handler) {
    const eventHandlers = this._hookHandlers.get(event);
    if (eventHandlers) {
      eventHandlers.push(handler);
    } else {
      this._hookHandlers.set(event, [handler]);
    }
  }
  // Removes a specific handler function for a specific event
  removeHandler(event, handler) {
    const eventHandlers = this._hookHandlers.get(event);
    if (eventHandlers) {
      const index = eventHandlers.indexOf(handler);
      if (index !== -1) {
        eventHandlers.splice(index, 1);
      }
    }
  }
  // Triggers all handlers for a specific event with provided data
  // biome-ignore lint/suspicious/noExplicitAny: type format
  trigger(event, data) {
    const eventHandlers = this._hookHandlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        try {
          handler(data);
        } catch (error) {
          this.emit(
            "error",
            new Error(
              `Error in hook handler for event "${event}": ${error.message}`
            )
          );
        }
      }
    }
  }
  // Provides read-only access to the current handlers
  get handlers() {
    return new Map(this._hookHandlers);
  }
};
var hooks_manager_default = HooksManager;

// src/stats-manager.ts
var StatsManager = class extends event_manager_default {
  enabled = true;
  hits = 0;
  misses = 0;
  sets = 0;
  deletes = 0;
  errors = 0;
  constructor(enabled) {
    super();
    if (enabled !== void 0) {
      this.enabled = enabled;
    }
    this.reset();
  }
  hit() {
    if (this.enabled) {
      this.hits++;
    }
  }
  miss() {
    if (this.enabled) {
      this.misses++;
    }
  }
  set() {
    if (this.enabled) {
      this.sets++;
    }
  }
  delete() {
    if (this.enabled) {
      this.deletes++;
    }
  }
  hitsOrMisses(array) {
    for (const item of array) {
      if (item === void 0) {
        this.miss();
      } else {
        this.hit();
      }
    }
  }
  reset() {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.deletes = 0;
    this.errors = 0;
  }
};
var stats_manager_default = StatsManager;

// src/index.ts
var KeyvHooks = /* @__PURE__ */ ((KeyvHooks2) => {
  KeyvHooks2["PRE_SET"] = "preSet";
  KeyvHooks2["POST_SET"] = "postSet";
  KeyvHooks2["PRE_GET"] = "preGet";
  KeyvHooks2["POST_GET"] = "postGet";
  KeyvHooks2["PRE_GET_MANY"] = "preGetMany";
  KeyvHooks2["POST_GET_MANY"] = "postGetMany";
  KeyvHooks2["PRE_GET_RAW"] = "preGetRaw";
  KeyvHooks2["POST_GET_RAW"] = "postGetRaw";
  KeyvHooks2["PRE_GET_MANY_RAW"] = "preGetManyRaw";
  KeyvHooks2["POST_GET_MANY_RAW"] = "postGetManyRaw";
  KeyvHooks2["PRE_DELETE"] = "preDelete";
  KeyvHooks2["POST_DELETE"] = "postDelete";
  return KeyvHooks2;
})(KeyvHooks || {});
var iterableAdapters = [
  "sqlite",
  "postgres",
  "mysql",
  "mongo",
  "redis",
  "valkey",
  "etcd"
];
var Keyv = class extends event_manager_default {
  opts;
  iterator;
  hooks = new hooks_manager_default();
  stats = new stats_manager_default(false);
  /**
   * Time to live in milliseconds
   */
  _ttl;
  /**
   * Namespace
   */
  _namespace;
  /**
   * Store
   */
  // biome-ignore lint/suspicious/noExplicitAny: type format
  _store = /* @__PURE__ */ new Map();
  _serialize = defaultSerialize;
  _deserialize = defaultDeserialize;
  _compression;
  _useKeyPrefix = true;
  _throwOnErrors = false;
  /**
   * Keyv Constructor
   * @param {KeyvStoreAdapter | KeyvOptions} store
   * @param {Omit<KeyvOptions, 'store'>} [options] if you provide the store you can then provide the Keyv Options
   */
  constructor(store, options) {
    super();
    options ??= {};
    store ??= {};
    this.opts = {
      namespace: "keyv",
      serialize: defaultSerialize,
      deserialize: defaultDeserialize,
      emitErrors: true,
      // @ts-expect-error - Map is not a KeyvStoreAdapter
      store: /* @__PURE__ */ new Map(),
      ...options
    };
    if (store && store.get) {
      this.opts.store = store;
    } else {
      this.opts = {
        ...this.opts,
        ...store
      };
    }
    this._store = this.opts.store ?? /* @__PURE__ */ new Map();
    this._compression = this.opts.compression;
    this._serialize = this.opts.serialize;
    this._deserialize = this.opts.deserialize;
    if (this.opts.namespace) {
      this._namespace = this.opts.namespace;
    }
    if (this._store) {
      if (!this._isValidStorageAdapter(this._store)) {
        throw new Error("Invalid storage adapter");
      }
      if (typeof this._store.on === "function") {
        this._store.on("error", (error) => this.emit("error", error));
      }
      this._store.namespace = this._namespace;
      if (typeof this._store[Symbol.iterator] === "function" && this._store instanceof Map) {
        this.iterator = this.generateIterator(
          this._store
        );
      } else if ("iterator" in this._store && this._store.opts && this._checkIterableAdapter()) {
        this.iterator = this.generateIterator(
          // biome-ignore lint/style/noNonNullAssertion: need to fix
          this._store.iterator.bind(this._store)
        );
      }
    }
    if (this.opts.stats) {
      this.stats.enabled = this.opts.stats;
    }
    if (this.opts.ttl) {
      this._ttl = this.opts.ttl;
    }
    if (this.opts.useKeyPrefix !== void 0) {
      this._useKeyPrefix = this.opts.useKeyPrefix;
    }
    if (this.opts.throwOnErrors !== void 0) {
      this._throwOnErrors = this.opts.throwOnErrors;
    }
  }
  /**
   * Get the current store
   */
  // biome-ignore lint/suspicious/noExplicitAny: type format
  get store() {
    return this._store;
  }
  /**
   * Set the current store. This will also set the namespace, event error handler, and generate the iterator. If the store is not valid it will throw an error.
   * @param {KeyvStoreAdapter | Map<any, any> | any} store the store to set
   */
  // biome-ignore lint/suspicious/noExplicitAny: type format
  set store(store) {
    if (this._isValidStorageAdapter(store)) {
      this._store = store;
      this.opts.store = store;
      if (typeof store.on === "function") {
        store.on("error", (error) => this.emit("error", error));
      }
      if (this._namespace) {
        this._store.namespace = this._namespace;
      }
      if (typeof store[Symbol.iterator] === "function" && store instanceof Map) {
        this.iterator = this.generateIterator(
          store
        );
      } else if ("iterator" in store && store.opts && this._checkIterableAdapter()) {
        this.iterator = this.generateIterator(store.iterator?.bind(store));
      }
    } else {
      throw new Error("Invalid storage adapter");
    }
  }
  /**
   * Get the current compression function
   * @returns {CompressionAdapter} The current compression function
   */
  get compression() {
    return this._compression;
  }
  /**
   * Set the current compression function
   * @param {CompressionAdapter} compress The compression function to set
   */
  set compression(compress) {
    this._compression = compress;
  }
  /**
   * Get the current namespace.
   * @returns {string | undefined} The current namespace.
   */
  get namespace() {
    return this._namespace;
  }
  /**
   * Set the current namespace.
   * @param {string | undefined} namespace The namespace to set.
   */
  set namespace(namespace) {
    this._namespace = namespace;
    this.opts.namespace = namespace;
    this._store.namespace = namespace;
    if (this.opts.store) {
      this.opts.store.namespace = namespace;
    }
  }
  /**
   * Get the current TTL.
   * @returns {number} The current TTL in milliseconds.
   */
  get ttl() {
    return this._ttl;
  }
  /**
   * Set the current TTL.
   * @param {number} ttl The TTL to set in milliseconds.
   */
  set ttl(ttl) {
    this.opts.ttl = ttl;
    this._ttl = ttl;
  }
  /**
   * Get the current serialize function.
   * @returns {Serialize} The current serialize function.
   */
  get serialize() {
    return this._serialize;
  }
  /**
   * Set the current serialize function.
   * @param {Serialize} serialize The serialize function to set.
   */
  set serialize(serialize) {
    this.opts.serialize = serialize;
    this._serialize = serialize;
  }
  /**
   * Get the current deserialize function.
   * @returns {Deserialize} The current deserialize function.
   */
  get deserialize() {
    return this._deserialize;
  }
  /**
   * Set the current deserialize function.
   * @param {Deserialize} deserialize The deserialize function to set.
   */
  set deserialize(deserialize) {
    this.opts.deserialize = deserialize;
    this._deserialize = deserialize;
  }
  /**
   * Get the current useKeyPrefix value. This will enable or disable key prefixing.
   * @returns {boolean} The current useKeyPrefix value.
   * @default true
   */
  get useKeyPrefix() {
    return this._useKeyPrefix;
  }
  /**
   * Set the current useKeyPrefix value. This will enable or disable key prefixing.
   * @param {boolean} value The useKeyPrefix value to set.
   */
  set useKeyPrefix(value) {
    this._useKeyPrefix = value;
    this.opts.useKeyPrefix = value;
  }
  /**
   * Get the current throwErrors value. This will enable or disable throwing errors on methods in addition to emitting them.
   * @return {boolean} The current throwOnErrors value.
   */
  get throwOnErrors() {
    return this._throwOnErrors;
  }
  /**
   * Set the current throwOnErrors value. This will enable or disable throwing errors on methods in addition to emitting them.
   * @param {boolean} value The throwOnErrors value to set.
   */
  set throwOnErrors(value) {
    this._throwOnErrors = value;
    this.opts.throwOnErrors = value;
  }
  generateIterator(iterator) {
    const function_ = async function* () {
      for await (const [key, raw] of typeof iterator === "function" ? iterator(this._store.namespace) : iterator) {
        const data = await this.deserializeData(raw);
        if (this._useKeyPrefix && this._store.namespace && !key.includes(this._store.namespace)) {
          continue;
        }
        if (typeof data.expires === "number" && Date.now() > data.expires) {
          await this.delete(key);
          continue;
        }
        yield [this._getKeyUnprefix(key), data.value];
      }
    };
    return function_.bind(this);
  }
  _checkIterableAdapter() {
    return iterableAdapters.includes(this._store.opts.dialect) || iterableAdapters.some(
      (element) => this._store.opts.url.includes(element)
    );
  }
  _getKeyPrefix(key) {
    if (!this._useKeyPrefix) {
      return key;
    }
    if (!this._namespace) {
      return key;
    }
    if (key.startsWith(`${this._namespace}:`)) {
      return key;
    }
    return `${this._namespace}:${key}`;
  }
  _getKeyPrefixArray(keys) {
    if (!this._useKeyPrefix) {
      return keys;
    }
    if (!this._namespace) {
      return keys;
    }
    return keys.map((key) => `${this._namespace}:${key}`);
  }
  _getKeyUnprefix(key) {
    if (!this._useKeyPrefix) {
      return key;
    }
    return key.split(":").splice(1).join(":");
  }
  // biome-ignore lint/suspicious/noExplicitAny: type format
  _isValidStorageAdapter(store) {
    return store instanceof Map || typeof store.get === "function" && typeof store.set === "function" && typeof store.delete === "function" && typeof store.clear === "function";
  }
  // eslint-disable-next-line @stylistic/max-len
  async get(key, options) {
    const { store } = this.opts;
    const isArray = Array.isArray(key);
    const keyPrefixed = isArray ? this._getKeyPrefixArray(key) : this._getKeyPrefix(key);
    const isDataExpired = (data) => typeof data.expires === "number" && Date.now() > data.expires;
    if (isArray) {
      if (options?.raw === true) {
        return this.getMany(key, { raw: true });
      }
      return this.getMany(key, { raw: false });
    }
    this.hooks.trigger("preGet" /* PRE_GET */, { key: keyPrefixed });
    let rawData;
    try {
      rawData = await store.get(keyPrefixed);
    } catch (error) {
      if (this.throwOnErrors) {
        throw error;
      }
    }
    const deserializedData = typeof rawData === "string" || this.opts.compression ? await this.deserializeData(rawData) : rawData;
    if (deserializedData === void 0 || deserializedData === null) {
      this.hooks.trigger("postGet" /* POST_GET */, {
        key: keyPrefixed,
        value: void 0
      });
      this.stats.miss();
      return void 0;
    }
    if (isDataExpired(deserializedData)) {
      await this.delete(key);
      this.hooks.trigger("postGet" /* POST_GET */, {
        key: keyPrefixed,
        value: void 0
      });
      this.stats.miss();
      return void 0;
    }
    this.hooks.trigger("postGet" /* POST_GET */, {
      key: keyPrefixed,
      value: deserializedData
    });
    this.stats.hit();
    return options?.raw ? deserializedData : deserializedData.value;
  }
  async getMany(keys, options) {
    const { store } = this.opts;
    const keyPrefixed = this._getKeyPrefixArray(keys);
    const isDataExpired = (data) => typeof data.expires === "number" && Date.now() > data.expires;
    this.hooks.trigger("preGetMany" /* PRE_GET_MANY */, { keys: keyPrefixed });
    if (store.getMany === void 0) {
      const promises = keyPrefixed.map(async (key) => {
        const rawData2 = await store.get(key);
        const deserializedRow = typeof rawData2 === "string" || this.opts.compression ? await this.deserializeData(rawData2) : rawData2;
        if (deserializedRow === void 0 || deserializedRow === null) {
          return void 0;
        }
        if (isDataExpired(deserializedRow)) {
          await this.delete(key);
          return void 0;
        }
        return options?.raw ? deserializedRow : deserializedRow.value;
      });
      const deserializedRows = await Promise.allSettled(promises);
      const result2 = deserializedRows.map(
        // biome-ignore lint/suspicious/noExplicitAny: type format
        (row) => row.value
      );
      this.hooks.trigger("postGetMany" /* POST_GET_MANY */, result2);
      if (result2.length > 0) {
        this.stats.hit();
      }
      return result2;
    }
    const rawData = await store.getMany(keyPrefixed);
    const result = [];
    const expiredKeys = [];
    for (const index in rawData) {
      let row = rawData[index];
      if (typeof row === "string") {
        row = await this.deserializeData(row);
      }
      if (row === void 0 || row === null) {
        result.push(void 0);
        continue;
      }
      if (isDataExpired(row)) {
        expiredKeys.push(keys[index]);
        result.push(void 0);
        continue;
      }
      const value = options?.raw ? row : row.value;
      result.push(value);
    }
    if (expiredKeys.length > 0) {
      await this.deleteMany(expiredKeys);
    }
    this.hooks.trigger("postGetMany" /* POST_GET_MANY */, result);
    if (result.length > 0) {
      this.stats.hit();
    }
    return result;
  }
  /**
   * Get the raw value of a key. This is the replacement for setting raw to true in the get() method.
   * @param {string} key the key to get
   * @returns {Promise<StoredDataRaw<Value> | undefined>} will return a StoredDataRaw<Value> or undefined if the key does not exist or is expired.
   */
  async getRaw(key) {
    const { store } = this.opts;
    const keyPrefixed = this._getKeyPrefix(key);
    this.hooks.trigger("preGetRaw" /* PRE_GET_RAW */, { key: keyPrefixed });
    const rawData = await store.get(keyPrefixed);
    if (rawData === void 0 || rawData === null) {
      this.hooks.trigger("postGetRaw" /* POST_GET_RAW */, {
        key: keyPrefixed,
        value: void 0
      });
      this.stats.miss();
      return void 0;
    }
    const deserializedData = typeof rawData === "string" || this.opts.compression ? await this.deserializeData(rawData) : rawData;
    if (deserializedData !== void 0 && deserializedData.expires !== void 0 && deserializedData.expires !== null && // biome-ignore lint/style/noNonNullAssertion: need to fix
    deserializedData.expires < Date.now()) {
      this.hooks.trigger("postGetRaw" /* POST_GET_RAW */, {
        key: keyPrefixed,
        value: void 0
      });
      this.stats.miss();
      await this.delete(key);
      return void 0;
    }
    this.stats.hit();
    this.hooks.trigger("postGetRaw" /* POST_GET_RAW */, {
      key: keyPrefixed,
      value: deserializedData
    });
    return deserializedData;
  }
  /**
   * Get the raw values of many keys. This is the replacement for setting raw to true in the getMany() method.
   * @param {string[]} keys the keys to get
   * @returns {Promise<Array<StoredDataRaw<Value>>>} will return an array of StoredDataRaw<Value> or undefined if the key does not exist or is expired.
   */
  async getManyRaw(keys) {
    const { store } = this.opts;
    const keyPrefixed = this._getKeyPrefixArray(keys);
    if (keys.length === 0) {
      const result2 = Array.from({ length: keys.length }).fill(
        void 0
      );
      this.stats.misses += keys.length;
      this.hooks.trigger("postGetManyRaw" /* POST_GET_MANY_RAW */, {
        keys: keyPrefixed,
        values: result2
      });
      return result2;
    }
    let result = [];
    if (store.getMany === void 0) {
      const promises = keyPrefixed.map(async (key) => {
        const rawData = await store.get(key);
        if (rawData !== void 0 && rawData !== null) {
          return this.deserializeData(rawData);
        }
        return void 0;
      });
      const deserializedRows = await Promise.allSettled(promises);
      result = deserializedRows.map(
        // biome-ignore lint/suspicious/noExplicitAny: type format
        (row) => row.value
      );
    } else {
      const rawData = await store.getMany(keyPrefixed);
      for (const row of rawData) {
        if (row !== void 0 && row !== null) {
          result.push(await this.deserializeData(row));
        } else {
          result.push(void 0);
        }
      }
    }
    const expiredKeys = [];
    const isDataExpired = (data) => typeof data.expires === "number" && Date.now() > data.expires;
    for (const [index, row] of result.entries()) {
      if (row !== void 0 && isDataExpired(row)) {
        expiredKeys.push(keyPrefixed[index]);
        result[index] = void 0;
      }
    }
    if (expiredKeys.length > 0) {
      await this.deleteMany(expiredKeys);
    }
    this.stats.hitsOrMisses(result);
    this.hooks.trigger("postGetManyRaw" /* POST_GET_MANY_RAW */, {
      keys: keyPrefixed,
      values: result
    });
    return result;
  }
  /**
   * Set an item to the store
   * @param {string | Array<KeyvEntry>} key the key to use. If you pass in an array of KeyvEntry it will set many items
   * @param {Value} value the value of the key
   * @param {number} [ttl] time to live in milliseconds
   * @returns {boolean} if it sets then it will return a true. On failure will return false.
   */
  async set(key, value, ttl) {
    const data = { key, value, ttl };
    this.hooks.trigger("preSet" /* PRE_SET */, data);
    const keyPrefixed = this._getKeyPrefix(data.key);
    data.ttl ??= this._ttl;
    if (data.ttl === 0) {
      data.ttl = void 0;
    }
    const { store } = this.opts;
    const expires = typeof data.ttl === "number" ? Date.now() + data.ttl : void 0;
    if (typeof data.value === "symbol") {
      this.emit("error", "symbol cannot be serialized");
      throw new Error("symbol cannot be serialized");
    }
    const formattedValue = { value: data.value, expires };
    const serializedValue = await this.serializeData(formattedValue);
    let result = true;
    try {
      const value2 = await store.set(keyPrefixed, serializedValue, data.ttl);
      if (typeof value2 === "boolean") {
        result = value2;
      }
    } catch (error) {
      result = false;
      this.emit("error", error);
      if (this._throwOnErrors) {
        throw error;
      }
    }
    this.hooks.trigger("postSet" /* POST_SET */, {
      key: keyPrefixed,
      value: serializedValue,
      ttl
    });
    this.stats.set();
    return result;
  }
  /**
   * Set many items to the store
   * @param {Array<KeyvEntry>} entries the entries to set
   * @returns {boolean[]} will return an array of booleans if it sets then it will return a true. On failure will return false.
   */
  // biome-ignore lint/correctness/noUnusedVariables: type format
  async setMany(entries) {
    let results = [];
    try {
      if (this._store.setMany === void 0) {
        const promises = [];
        for (const entry of entries) {
          promises.push(this.set(entry.key, entry.value, entry.ttl));
        }
        const promiseResults = await Promise.all(promises);
        results = promiseResults;
      } else {
        const serializedEntries = await Promise.all(
          entries.map(async ({ key, value, ttl }) => {
            ttl ??= this._ttl;
            if (ttl === 0) {
              ttl = void 0;
            }
            const expires = typeof ttl === "number" ? Date.now() + ttl : void 0;
            if (typeof value === "symbol") {
              this.emit("error", "symbol cannot be serialized");
              throw new Error("symbol cannot be serialized");
            }
            const formattedValue = { value, expires };
            const serializedValue = await this.serializeData(formattedValue);
            const keyPrefixed = this._getKeyPrefix(key);
            return { key: keyPrefixed, value: serializedValue, ttl };
          })
        );
        results = await this._store.setMany(serializedEntries);
      }
    } catch (error) {
      this.emit("error", error);
      if (this._throwOnErrors) {
        throw error;
      }
      results = entries.map(() => false);
    }
    return results;
  }
  /**
   * Delete an Entry
   * @param {string | string[]} key the key to be deleted. if an array it will delete many items
   * @returns {boolean} will return true if item or items are deleted. false if there is an error
   */
  async delete(key) {
    const { store } = this.opts;
    if (Array.isArray(key)) {
      return this.deleteMany(key);
    }
    const keyPrefixed = this._getKeyPrefix(key);
    this.hooks.trigger("preDelete" /* PRE_DELETE */, { key: keyPrefixed });
    let result = true;
    try {
      const value = await store.delete(keyPrefixed);
      if (typeof value === "boolean") {
        result = value;
      }
    } catch (error) {
      result = false;
      this.emit("error", error);
      if (this._throwOnErrors) {
        throw error;
      }
    }
    this.hooks.trigger("postDelete" /* POST_DELETE */, {
      key: keyPrefixed,
      value: result
    });
    this.stats.delete();
    return result;
  }
  /**
   * Delete many items from the store
   * @param {string[]} keys the keys to be deleted
   * @returns {boolean} will return true if item or items are deleted. false if there is an error
   */
  async deleteMany(keys) {
    try {
      const { store } = this.opts;
      const keyPrefixed = this._getKeyPrefixArray(keys);
      this.hooks.trigger("preDelete" /* PRE_DELETE */, { key: keyPrefixed });
      if (store.deleteMany !== void 0) {
        return await store.deleteMany(keyPrefixed);
      }
      const promises = keyPrefixed.map(async (key) => store.delete(key));
      const results = await Promise.all(promises);
      const returnResult = results.every(Boolean);
      this.hooks.trigger("postDelete" /* POST_DELETE */, {
        key: keyPrefixed,
        value: returnResult
      });
      return returnResult;
    } catch (error) {
      this.emit("error", error);
      if (this._throwOnErrors) {
        throw error;
      }
      return false;
    }
  }
  /**
   * Clear the store
   * @returns {void}
   */
  async clear() {
    this.emit("clear");
    const { store } = this.opts;
    try {
      await store.clear();
    } catch (error) {
      this.emit("error", error);
      if (this._throwOnErrors) {
        throw error;
      }
    }
  }
  async has(key) {
    if (Array.isArray(key)) {
      return this.hasMany(key);
    }
    const keyPrefixed = this._getKeyPrefix(key);
    const { store } = this.opts;
    if (store.has !== void 0 && !(store instanceof Map)) {
      return store.has(keyPrefixed);
    }
    let rawData;
    try {
      rawData = await store.get(keyPrefixed);
    } catch (error) {
      this.emit("error", error);
      if (this._throwOnErrors) {
        throw error;
      }
      return false;
    }
    if (rawData) {
      const data = await this.deserializeData(rawData);
      if (data) {
        if (data.expires === void 0 || data.expires === null) {
          return true;
        }
        return data.expires > Date.now();
      }
    }
    return false;
  }
  /**
   * Check if many keys exist
   * @param {string[]} keys the keys to check
   * @returns {boolean[]} will return an array of booleans if the keys exist
   */
  async hasMany(keys) {
    const keyPrefixed = this._getKeyPrefixArray(keys);
    const { store } = this.opts;
    if (store.hasMany !== void 0) {
      return store.hasMany(keyPrefixed);
    }
    const results = [];
    for (const key of keys) {
      results.push(await this.has(key));
    }
    return results;
  }
  /**
   * Will disconnect the store. This is only available if the store has a disconnect method
   * @returns {Promise<void>}
   */
  async disconnect() {
    const { store } = this.opts;
    this.emit("disconnect");
    if (typeof store.disconnect === "function") {
      return store.disconnect();
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: type format
  emit(event, ...arguments_) {
    if (event === "error" && !this.opts.emitErrors) {
      return;
    }
    super.emit(event, ...arguments_);
  }
  async serializeData(data) {
    if (!this._serialize) {
      return data;
    }
    if (this._compression?.compress) {
      return this._serialize({
        value: await this._compression.compress(data.value),
        expires: data.expires
      });
    }
    return this._serialize(data);
  }
  async deserializeData(data) {
    if (!this._deserialize) {
      return data;
    }
    if (this._compression?.decompress && typeof data === "string") {
      const result = await this._deserialize(data);
      return {
        value: await this._compression.decompress(result?.value),
        expires: result?.expires
      };
    }
    if (typeof data === "string") {
      return this._deserialize(data);
    }
    return void 0;
  }
};
var index_default = (/* unused pure expression or super */ null && (Keyv));

/* v8 ignore next -- @preserve */

;// CONCATENATED MODULE: ./node_modules/mimic-response/index.js
// We define these manually to ensure they're always copied
// even if they would move up the prototype chain
// https://nodejs.org/api/http.html#http_class_http_incomingmessage
const knownProperties = [
	'aborted',
	'complete',
	'headers',
	'httpVersion',
	'httpVersionMinor',
	'httpVersionMajor',
	'method',
	'rawHeaders',
	'rawTrailers',
	'setTimeout',
	'socket',
	'statusCode',
	'statusMessage',
	'trailers',
	'url',
];

function mimicResponse(fromStream, toStream) {
	if (toStream._readableState.autoDestroy) {
		throw new Error('The second stream must have the `autoDestroy` option set to `false`');
	}

	const fromProperties = new Set([...Object.keys(fromStream), ...knownProperties]);

	const properties = {};

	for (const property of fromProperties) {
		// Don't overwrite existing properties.
		if (property in toStream) {
			continue;
		}

		properties[property] = {
			get() {
				const value = fromStream[property];
				const isFunction = typeof value === 'function';

				return isFunction ? value.bind(fromStream) : value;
			},
			set(value) {
				fromStream[property] = value;
			},
			enumerable: true,
			configurable: false,
		};
	}

	Object.defineProperties(toStream, properties);

	fromStream.once('aborted', () => {
		toStream.destroy();

		toStream.emit('aborted');
	});

	fromStream.once('close', () => {
		if (fromStream.complete) {
			if (toStream.readable) {
				toStream.once('end', () => {
					toStream.emit('close');
				});
			} else {
				toStream.emit('close');
			}
		} else {
			toStream.emit('close');
		}
	});

	return toStream;
}

;// CONCATENATED MODULE: ./node_modules/normalize-url/index.js
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/Data_URIs
const DATA_URL_DEFAULT_MIME_TYPE = 'text/plain';
const DATA_URL_DEFAULT_CHARSET = 'us-ascii';

const testParameter = (name, filters) => filters.some(filter => filter instanceof RegExp ? filter.test(name) : filter === name);

const supportedProtocols = new Set([
	'https:',
	'http:',
	'file:',
]);

const hasCustomProtocol = urlString => {
	try {
		const {protocol} = new URL(urlString);

		return protocol.endsWith(':')
			&& !protocol.includes('.')
			&& !supportedProtocols.has(protocol);
	} catch {
		return false;
	}
};

const normalizeDataURL = (urlString, {stripHash}) => {
	const match = /^data:(?<type>[^,]*?),(?<data>[^#]*?)(?:#(?<hash>.*))?$/.exec(urlString);

	if (!match) {
		throw new Error(`Invalid URL: ${urlString}`);
	}

	const {type, data, hash} = match.groups;
	const mediaType = type.split(';');

	const isBase64 = mediaType.at(-1) === 'base64';
	if (isBase64) {
		mediaType.pop();
	}

	// Lowercase MIME type
	const mimeType = mediaType.shift()?.toLowerCase() ?? '';
	const attributes = mediaType
		.map(attribute => {
			let [key, value = ''] = attribute.split('=').map(string => string.trim());

			// Lowercase `charset`
			if (key === 'charset') {
				value = value.toLowerCase();

				if (value === DATA_URL_DEFAULT_CHARSET) {
					return '';
				}
			}

			return `${key}${value ? `=${value}` : ''}`;
		})
		.filter(Boolean);

	const normalizedMediaType = [...attributes];

	if (isBase64) {
		normalizedMediaType.push('base64');
	}

	if (normalizedMediaType.length > 0 || (mimeType && mimeType !== DATA_URL_DEFAULT_MIME_TYPE)) {
		normalizedMediaType.unshift(mimeType);
	}

	const hashPart = stripHash || !hash ? '' : `#${hash}`;
	return `data:${normalizedMediaType.join(';')},${isBase64 ? data.trim() : data}${hashPart}`;
};

function normalizeUrl(urlString, options) {
	options = {
		defaultProtocol: 'http',
		normalizeProtocol: true,
		forceHttp: false,
		forceHttps: false,
		stripAuthentication: true,
		stripHash: false,
		stripTextFragment: true,
		stripWWW: true,
		removeQueryParameters: [/^utm_\w+/i],
		removeTrailingSlash: true,
		removeSingleSlash: true,
		removeDirectoryIndex: false,
		removeExplicitPort: false,
		sortQueryParameters: true,
		removePath: false,
		transformPath: false,
		...options,
	};

	// Legacy: Append `:` to the protocol if missing.
	if (typeof options.defaultProtocol === 'string' && !options.defaultProtocol.endsWith(':')) {
		options.defaultProtocol = `${options.defaultProtocol}:`;
	}

	urlString = urlString.trim();

	// Data URL
	if (/^data:/i.test(urlString)) {
		return normalizeDataURL(urlString, options);
	}

	if (hasCustomProtocol(urlString)) {
		return urlString;
	}

	const hasRelativeProtocol = urlString.startsWith('//');
	const isRelativeUrl = !hasRelativeProtocol && /^\.*\//.test(urlString);

	// Prepend protocol
	if (!isRelativeUrl) {
		urlString = urlString.replace(/^(?!(?:\w+:)?\/\/)|^\/\//, options.defaultProtocol);
	}

	const urlObject = new URL(urlString);

	if (options.forceHttp && options.forceHttps) {
		throw new Error('The `forceHttp` and `forceHttps` options cannot be used together');
	}

	if (options.forceHttp && urlObject.protocol === 'https:') {
		urlObject.protocol = 'http:';
	}

	if (options.forceHttps && urlObject.protocol === 'http:') {
		urlObject.protocol = 'https:';
	}

	// Remove auth
	if (options.stripAuthentication) {
		urlObject.username = '';
		urlObject.password = '';
	}

	// Remove hash
	if (options.stripHash) {
		urlObject.hash = '';
	} else if (options.stripTextFragment) {
		urlObject.hash = urlObject.hash.replace(/#?:~:text.*?$/i, '');
	}

	// Remove duplicate slashes if not preceded by a protocol
	// NOTE: This could be implemented using a single negative lookbehind
	// regex, but we avoid that to maintain compatibility with older js engines
	// which do not have support for that feature.
	if (urlObject.pathname) {
		// TODO: Replace everything below with `urlObject.pathname = urlObject.pathname.replace(/(?<!\b[a-z][a-z\d+\-.]{1,50}:)\/{2,}/g, '/');` when Safari supports negative lookbehind.

		// Split the string by occurrences of this protocol regex, and perform
		// duplicate-slash replacement on the strings between those occurrences
		// (if any).
		const protocolRegex = /\b[a-z][a-z\d+\-.]{1,50}:\/\//g;

		let lastIndex = 0;
		let result = '';
		for (;;) {
			const match = protocolRegex.exec(urlObject.pathname);
			if (!match) {
				break;
			}

			const protocol = match[0];
			const protocolAtIndex = match.index;
			const intermediate = urlObject.pathname.slice(lastIndex, protocolAtIndex);

			result += intermediate.replace(/\/{2,}/g, '/');
			result += protocol;
			lastIndex = protocolAtIndex + protocol.length;
		}

		const remnant = urlObject.pathname.slice(lastIndex, urlObject.pathname.length);
		result += remnant.replace(/\/{2,}/g, '/');

		urlObject.pathname = result;
	}

	// Decode URI octets
	if (urlObject.pathname) {
		try {
			urlObject.pathname = decodeURI(urlObject.pathname).replace(/\\/g, '%5C');
		} catch {}
	}

	// Remove directory index
	if (options.removeDirectoryIndex === true) {
		options.removeDirectoryIndex = [/^index\.[a-z]+$/];
	}

	if (Array.isArray(options.removeDirectoryIndex) && options.removeDirectoryIndex.length > 0) {
		const pathComponents = urlObject.pathname.split('/').filter(Boolean);
		const lastComponent = pathComponents.at(-1);

		if (lastComponent && testParameter(lastComponent, options.removeDirectoryIndex)) {
			pathComponents.pop();
			urlObject.pathname = pathComponents.length > 0 ? `/${pathComponents.join('/')}/` : '/';
		}
	}

	// Remove path
	if (options.removePath) {
		urlObject.pathname = '/';
	}

	// Transform path components
	if (options.transformPath && typeof options.transformPath === 'function') {
		const pathComponents = urlObject.pathname.split('/').filter(Boolean);
		const newComponents = options.transformPath(pathComponents);
		urlObject.pathname = newComponents?.length > 0 ? `/${newComponents.join('/')}` : '/';
	}

	if (urlObject.hostname) {
		// Remove trailing dot
		urlObject.hostname = urlObject.hostname.replace(/\.$/, '');

		// Remove `www.`
		if (options.stripWWW && /^www\.(?!www\.)[a-z\-\d]{1,63}\.[a-z.\-\d]{2,63}$/.test(urlObject.hostname)) {
			// Each label should be max 63 at length (min: 1).
			// Source: https://en.wikipedia.org/wiki/Hostname#Restrictions_on_valid_host_names
			// Each TLD should be up to 63 characters long (min: 2).
			// It is technically possible to have a single character TLD, but none currently exist.
			urlObject.hostname = urlObject.hostname.replace(/^www\./, '');
		}
	}

	// Remove query unwanted parameters
	if (Array.isArray(options.removeQueryParameters)) {
		// eslint-disable-next-line unicorn/no-useless-spread -- We are intentionally spreading to get a copy.
		for (const key of [...urlObject.searchParams.keys()]) {
			if (testParameter(key, options.removeQueryParameters)) {
				urlObject.searchParams.delete(key);
			}
		}
	}

	if (!Array.isArray(options.keepQueryParameters) && options.removeQueryParameters === true) {
		urlObject.search = '';
	}

	// Keep wanted query parameters
	if (Array.isArray(options.keepQueryParameters) && options.keepQueryParameters.length > 0) {
		// eslint-disable-next-line unicorn/no-useless-spread -- We are intentionally spreading to get a copy.
		for (const key of [...urlObject.searchParams.keys()]) {
			if (!testParameter(key, options.keepQueryParameters)) {
				urlObject.searchParams.delete(key);
			}
		}
	}

	// Sort query parameters
	if (options.sortQueryParameters) {
		const originalSearch = urlObject.search;
		urlObject.searchParams.sort();

		// Calling `.sort()` encodes the search parameters, so we need to decode them again.
		try {
			urlObject.search = decodeURIComponent(urlObject.search);
		} catch {}

		// Fix parameters that originally had no equals sign but got one added by URLSearchParams
		const partsWithoutEquals = originalSearch.slice(1).split('&').filter(p => p && !p.includes('='));
		for (const part of partsWithoutEquals) {
			const decoded = decodeURIComponent(part);
			// Only replace at word boundaries to avoid partial matches
			urlObject.search = urlObject.search.replace(`?${decoded}=`, `?${decoded}`).replace(`&${decoded}=`, `&${decoded}`);
		}
	}

	if (options.removeTrailingSlash) {
		urlObject.pathname = urlObject.pathname.replace(/\/$/, '');
	}

	// Remove an explicit port number, excluding a default port number, if applicable
	if (options.removeExplicitPort && urlObject.port) {
		urlObject.port = '';
	}

	const oldUrlString = urlString;

	// Take advantage of many of the Node `url` normalizations
	urlString = urlObject.toString();

	if (!options.removeSingleSlash && urlObject.pathname === '/' && !oldUrlString.endsWith('/') && urlObject.hash === '') {
		urlString = urlString.replace(/\/$/, '');
	}

	// Remove ending `/` unless removeSingleSlash is false
	if ((options.removeTrailingSlash || urlObject.pathname === '/') && urlObject.hash === '' && options.removeSingleSlash) {
		urlString = urlString.replace(/\/$/, '');
	}

	// Restore relative protocol, if applicable
	if (hasRelativeProtocol && !options.normalizeProtocol) {
		urlString = urlString.replace(/^http:\/\//, '//');
	}

	// Remove http/https
	if (options.stripProtocol) {
		urlString = urlString.replace(/^(?:https?:)?\/\//, '');
	}

	return urlString;
}

;// CONCATENATED MODULE: ./node_modules/responselike/node_modules/lowercase-keys/index.js
function lowercaseKeys(object) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key.toLowerCase(), value]));
}

;// CONCATENATED MODULE: ./node_modules/responselike/index.js



class Response extends external_node_stream_.Readable {
	statusCode;
	headers;
	body;
	url;
	complete;

	constructor({statusCode, headers, body, url}) {
		if (typeof statusCode !== 'number') {
			throw new TypeError('Argument `statusCode` should be a number');
		}

		if (typeof headers !== 'object') {
			throw new TypeError('Argument `headers` should be an object');
		}

		if (!(body instanceof Uint8Array)) {
			throw new TypeError('Argument `body` should be a buffer');
		}

		if (typeof url !== 'string') {
			throw new TypeError('Argument `url` should be a string');
		}

		let bodyPushed = false;
		super({
			read() {
				// Push body on first read, end stream on second read.
				// This allows listeners to attach before data flows through pipes.
				if (!bodyPushed) {
					bodyPushed = true;
					this.push(body);
					return;
				}

				this.push(null);
			},
		});

		this.statusCode = statusCode;
		this.headers = lowercaseKeys(headers);
		this.body = body;
		this.url = url;
		this.complete = true;
	}
}

;// CONCATENATED MODULE: ./node_modules/cacheable-request/dist/types.js
// Type definitions for cacheable-request 6.0
// Project: https://github.com/lukechilds/cacheable-request#readme
// Definitions by: BendingBender <https://github.com/BendingBender>
//                 Paul Melnikow <https://github.com/paulmelnikow>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped
// TypeScript Version: 2.3
class types_RequestError extends Error {
    constructor(error) {
        super(error.message);
        Object.defineProperties(this, Object.getOwnPropertyDescriptors(error));
    }
}
class types_CacheError extends Error {
    constructor(error) {
        super(error.message);
        Object.defineProperties(this, Object.getOwnPropertyDescriptors(error));
    }
}
//# sourceMappingURL=types.js.map
;// CONCATENATED MODULE: ./node_modules/cacheable-request/dist/index.js
// biome-ignore-all lint/suspicious/noImplicitAnyLet: legacy format
// biome-ignore-all lint/suspicious/noExplicitAny: legacy format











class CacheableRequest {
    constructor(cacheRequest, cacheAdapter) {
        this.cache = new Keyv({ namespace: "cacheable-request" });
        this.hooks = new Map();
        this.request = () => (options, callback) => {
            let url;
            if (typeof options === "string") {
                url = normalizeUrlObject(parseWithWhatwg(options));
                options = {};
            }
            else if (options instanceof external_node_url_.URL) {
                url = normalizeUrlObject(parseWithWhatwg(options.toString()));
                options = {};
            }
            else {
                const [pathname, ...searchParts] = (options.path ?? "").split("?");
                const search = searchParts.length > 0 ? `?${searchParts.join("?")}` : "";
                url = normalizeUrlObject({ ...options, pathname, search });
            }
            options = {
                headers: {},
                method: "GET",
                cache: true,
                strictTtl: false,
                automaticFailover: false,
                ...options,
                ...urlObjectToRequestOptions(url),
            };
            options.headers = Object.fromEntries(entries(options.headers).map(([key, value]) => [
                key.toLowerCase(),
                value,
            ]));
            const ee = new external_node_events_();
            const normalizedUrlString = normalizeUrl(external_node_url_.format(url), {
                stripWWW: false,
                removeTrailingSlash: false,
                stripAuthentication: false,
            });
            let key = `${options.method}:${normalizedUrlString}`;
            // POST, PATCH, and PUT requests may be cached, depending on the response
            // cache-control headers. As a result, the body of the request should be
            // added to the cache key in order to avoid collisions.
            if (options.body &&
                options.method !== undefined &&
                ["POST", "PATCH", "PUT"].includes(options.method)) {
                if (options.body instanceof external_node_stream_.Readable) {
                    // Streamed bodies should completely skip the cache because they may
                    // or may not be hashable and in either case the stream would need to
                    // close before the cache key could be generated.
                    options.cache = false;
                }
                else {
                    key += `:${external_node_crypto_.createHash("md5").update(options.body).digest("hex")}`;
                }
            }
            let revalidate = false;
            let madeRequest = false;
            const makeRequest = (options_) => {
                madeRequest = true;
                let requestErrored = false;
                /* c8 ignore next 4 */
                let requestErrorCallback = () => {
                    /* do nothing */
                };
                const requestErrorPromise = new Promise((resolve) => {
                    requestErrorCallback = () => {
                        if (!requestErrored) {
                            requestErrored = true;
                            resolve();
                        }
                    };
                });
                const handler = async (response) => {
                    if (revalidate) {
                        response.status = response.statusCode;
                        const originalPolicy = http_cache_semantics.fromObject(revalidate.cachePolicy);
                        const revalidatedPolicy = originalPolicy.revalidatedPolicy(options_, response);
                        if (!revalidatedPolicy.modified) {
                            response.resume();
                            await new Promise((resolve) => {
                                // Skipping 'error' handler cause 'error' event should't be emitted for 304 response
                                response.once("end", resolve);
                            });
                            // Get headers from revalidated policy
                            const headers = convertHeaders(revalidatedPolicy.policy.responseHeaders());
                            // Preserve headers from the original cached response that may have been
                            // lost during revalidation (e.g., content-encoding, content-type, etc.)
                            // This works around a limitation in http-cache-semantics where some headers
                            // are not preserved when a 304 response has minimal headers
                            const originalHeaders = convertHeaders(originalPolicy.responseHeaders());
                            // Headers that should be preserved from the cached response
                            // according to RFC 7232 section 4.1
                            const preserveHeaders = [
                                "content-encoding",
                                "content-type",
                                "content-length",
                                "content-language",
                                "content-location",
                                "etag",
                            ];
                            for (const headerName of preserveHeaders) {
                                if (originalHeaders[headerName] !== undefined &&
                                    headers[headerName] === undefined) {
                                    headers[headerName] = originalHeaders[headerName];
                                }
                            }
                            response = new Response({
                                statusCode: revalidate.statusCode,
                                headers,
                                body: revalidate.body,
                                url: revalidate.url,
                            });
                            response.cachePolicy = revalidatedPolicy.policy;
                            response.fromCache = true;
                        }
                    }
                    if (!response.fromCache) {
                        response.cachePolicy = new http_cache_semantics(options_, response, options_);
                        response.fromCache = false;
                    }
                    let clonedResponse;
                    if (options_.cache && response.cachePolicy.storable()) {
                        clonedResponse = cloneResponse(response);
                        (async () => {
                            try {
                                const bodyPromise = getStreamAsBuffer(response);
                                await Promise.race([
                                    requestErrorPromise,
                                    new Promise((resolve) => response.once("end", resolve)),
                                    new Promise((resolve) => response.once("close", resolve)),
                                ]);
                                const body = await bodyPromise;
                                let value = {
                                    url: response.url,
                                    statusCode: response.fromCache
                                        ? revalidate.statusCode
                                        : response.statusCode,
                                    body,
                                    cachePolicy: response.cachePolicy.toObject(),
                                };
                                let ttl = options_.strictTtl
                                    ? response.cachePolicy.timeToLive()
                                    : undefined;
                                if (options_.maxTtl) {
                                    ttl = ttl ? Math.min(ttl, options_.maxTtl) : options_.maxTtl;
                                }
                                if (this.hooks.size > 0) {
                                    for (const key_ of this.hooks.keys()) {
                                        value = await this.runHook(key_, value, response);
                                    }
                                }
                                await this.cache.set(key, value, ttl);
                                /* c8 ignore next -- @preserve */
                            }
                            catch (error) {
                                /* c8 ignore next -- @preserve */
                                ee.emit("error", new types_CacheError(error));
                                /* c8 ignore next -- @preserve */
                            }
                        })();
                    }
                    else if (options_.cache && revalidate) {
                        (async () => {
                            try {
                                await this.cache.delete(key);
                                /* c8 ignore next -- @preserve */
                            }
                            catch (error) {
                                /* c8 ignore next -- @preserve */
                                ee.emit("error", new types_CacheError(error));
                                /* c8 ignore next -- @preserve */
                            }
                        })();
                    }
                    ee.emit("response", clonedResponse ?? response);
                    if (typeof callback === "function") {
                        callback(clonedResponse ?? response);
                    }
                };
                try {
                    const request_ = this.cacheRequest(options_, handler);
                    request_.once("error", requestErrorCallback);
                    request_.once("abort", requestErrorCallback);
                    request_.once("destroy", requestErrorCallback);
                    ee.emit("request", request_);
                }
                catch (error) {
                    ee.emit("error", new types_RequestError(error));
                }
            };
            (async () => {
                const get = async (options_) => {
                    await Promise.resolve();
                    const cacheEntry = options_.cache
                        ? await this.cache.get(key)
                        : undefined;
                    if (cacheEntry === undefined && !options_.forceRefresh) {
                        makeRequest(options_);
                        return;
                    }
                    const policy = http_cache_semantics.fromObject(cacheEntry.cachePolicy);
                    if (policy.satisfiesWithoutRevalidation(options_) &&
                        !options_.forceRefresh) {
                        const headers = convertHeaders(policy.responseHeaders());
                        const bodyBuffer = cacheEntry.body;
                        const body = Buffer.from(bodyBuffer);
                        const response = new Response({
                            statusCode: cacheEntry.statusCode,
                            headers,
                            body,
                            url: cacheEntry.url,
                        });
                        response.cachePolicy = policy;
                        response.fromCache = true;
                        ee.emit("response", response);
                        if (typeof callback === "function") {
                            callback(response);
                        }
                    }
                    else if (policy.satisfiesWithoutRevalidation(options_) &&
                        Date.now() >= policy.timeToLive() &&
                        options_.forceRefresh) {
                        await this.cache.delete(key);
                        options_.headers = policy.revalidationHeaders(options_);
                        makeRequest(options_);
                    }
                    else {
                        revalidate = cacheEntry;
                        options_.headers = policy.revalidationHeaders(options_);
                        makeRequest(options_);
                    }
                };
                const errorHandler = (error) => ee.emit("error", new types_CacheError(error));
                if (this.cache instanceof Keyv) {
                    const cachek = this.cache;
                    cachek.once("error", errorHandler);
                    ee.on("error", () => {
                        cachek.removeListener("error", errorHandler);
                    });
                    ee.on("response", () => {
                        cachek.removeListener("error", errorHandler);
                    });
                }
                try {
                    await get(options);
                }
                catch (error) {
                    /* v8 ignore next -- @preserve */
                    if (options.automaticFailover && !madeRequest) {
                        makeRequest(options);
                    }
                    ee.emit("error", new types_CacheError(error));
                }
            })();
            return ee;
        };
        this.addHook = (name, function_) => {
            if (!this.hooks.has(name)) {
                this.hooks.set(name, function_);
            }
        };
        this.removeHook = (name) => this.hooks.delete(name);
        this.getHook = (name) => this.hooks.get(name);
        this.runHook = async (name, ...arguments_) => this.hooks.get(name)?.(...arguments_);
        if (cacheAdapter) {
            if (cacheAdapter instanceof Keyv) {
                this.cache = cacheAdapter;
            }
            else {
                this.cache = new Keyv({
                    store: cacheAdapter,
                    namespace: "cacheable-request",
                });
            }
        }
        this.request = this.request.bind(this);
        this.cacheRequest = cacheRequest;
    }
}
const entries = Object.entries;
const cloneResponse = (response) => {
    const clone = new external_node_stream_.PassThrough({ autoDestroy: false });
    mimicResponse(response, clone);
    return response.pipe(clone);
};
const urlObjectToRequestOptions = (url) => {
    const options = { ...url };
    options.path = `${url.pathname || "/"}${url.search || ""}`;
    delete options.pathname;
    delete options.search;
    return options;
};
const normalizeUrlObject = (url) => 
// If url was parsed by url.parse or new URL:
// - hostname will be set
// - host will be hostname[:port]
// - port will be set if it was explicit in the parsed string
// Otherwise, url was from request options:
// - hostname or host may be set
// - host shall not have port encoded
({
    protocol: url.protocol,
    auth: url.auth,
    hostname: url.hostname || url.host || "localhost",
    port: url.port,
    pathname: url.pathname,
    search: url.search,
});
const convertHeaders = (headers) => {
    const result = [];
    for (const name of Object.keys(headers)) {
        result[name.toLowerCase()] = headers[name];
    }
    return result;
};
const parseWithWhatwg = (raw) => {
    const u = new external_node_url_.URL(raw);
    // If normalizeUrlObject expects the same fields as url.parse()
    return {
        protocol: u.protocol, // E.g. 'https:'
        slashes: true, // Always true for WHATWG URLs
        /* c8 ignore next 3 */
        auth: u.username || u.password ? `${u.username}:${u.password}` : undefined,
        host: u.host, // E.g. 'example.com:8080'
        port: u.port, // E.g. '8080'
        hostname: u.hostname, // E.g. 'example.com'
        hash: u.hash, // E.g. '#quux'
        search: u.search, // E.g. '?bar=baz'
        query: Object.fromEntries(u.searchParams), // { bar: 'baz' }
        pathname: u.pathname, // E.g. '/foo'
        path: u.pathname + u.search, // '/foo?bar=baz'
        href: u.href, // Full serialized URL
    };
};
/* harmony default export */ const dist = (CacheableRequest);

const onResponse = "onResponse";
//# sourceMappingURL=index.js.map
// EXTERNAL MODULE: external "node:util"
var external_node_util_ = __webpack_require__(57975);
;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/timer.js


const getInitialConnectionTimings = (socket) => Reflect.get(socket, '__initial_connection_timings__');
const setInitialConnectionTimings = (socket, timings) => {
    Reflect.set(socket, '__initial_connection_timings__', timings);
};
const timer = (request) => {
    if (request.timings) {
        return request.timings;
    }
    const timings = {
        start: Date.now(),
        socket: undefined,
        lookup: undefined,
        connect: undefined,
        secureConnect: undefined,
        upload: undefined,
        response: undefined,
        end: undefined,
        error: undefined,
        abort: undefined,
        phases: {
            wait: undefined,
            dns: undefined,
            tcp: undefined,
            tls: undefined,
            request: undefined,
            firstByte: undefined,
            download: undefined,
            total: undefined,
        },
    };
    request.timings = timings;
    const handleError = (origin) => {
        origin.once(external_node_events_.errorMonitor, () => {
            timings.error = Date.now();
            timings.phases.total = timings.error - timings.start;
        });
    };
    handleError(request);
    const onAbort = () => {
        timings.abort = Date.now();
        timings.phases.total = timings.abort - timings.start;
    };
    request.prependOnceListener('abort', onAbort);
    const onSocket = (socket) => {
        timings.socket = Date.now();
        timings.phases.wait = timings.socket - timings.start;
        if (external_node_util_.types.isProxy(socket)) {
            // HTTP/2: The socket is a proxy, so connection events won't fire.
            // We can't measure connection timings, so leave them undefined.
            // This prevents NaN in phases.request calculation.
            return;
        }
        // Check if socket is already connected (reused from connection pool)
        const socketAlreadyConnected = socket.writable && !socket.connecting;
        if (socketAlreadyConnected) {
            // Socket reuse detected: the socket was already connected from a previous request.
            // For reused sockets, set all connection timestamps to socket time since no new
            // connection was made for THIS request. But preserve phase durations from the
            // original connection so they're not lost.
            timings.lookup = timings.socket;
            timings.connect = timings.socket;
            const initialConnectionTimings = getInitialConnectionTimings(socket);
            if (initialConnectionTimings) {
                // Restore the phase timings from the initial connection
                timings.phases.dns = initialConnectionTimings.dnsPhase;
                timings.phases.tcp = initialConnectionTimings.tcpPhase;
                timings.phases.tls = initialConnectionTimings.tlsPhase;
                // Set secureConnect timestamp if there was TLS
                if (timings.phases.tls !== undefined) {
                    timings.secureConnect = timings.socket;
                }
            }
            else {
                // Socket reused but no initial timings stored (e.g., from external code)
                // Set phases to 0
                timings.phases.dns = 0;
                timings.phases.tcp = 0;
            }
            return;
        }
        const lookupListener = () => {
            timings.lookup = Date.now();
            timings.phases.dns = timings.lookup - timings.socket;
        };
        socket.prependOnceListener('lookup', lookupListener);
        if (!socket.connecting) {
            return;
        }
        const onSecureConnect = () => {
            timings.secureConnect = Date.now();
            timings.phases.tls = timings.secureConnect - timings.connect;
            // Update stored timings with TLS phase timing
            const initialConnectionTimings = getInitialConnectionTimings(socket);
            if (initialConnectionTimings) {
                initialConnectionTimings.tlsPhase = timings.phases.tls;
            }
        };
        socket.once('connect', () => {
            timings.connect = Date.now();
            if (timings.lookup === undefined) {
                // No DNS lookup occurred (e.g., connecting to an IP address directly)
                // Set lookup to socket time (no time elapsed for DNS)
                socket.removeListener('lookup', lookupListener);
                timings.lookup = timings.socket;
                timings.phases.dns = 0;
            }
            timings.phases.tcp = timings.connect - timings.lookup;
            // If lookup and connect happen at the EXACT same time (tcp = 0),
            // DNS was served from cache and the dns value is just event loop overhead.
            // Set dns to 0 to indicate no actual DNS resolution occurred.
            // Fixes https://github.com/szmarczak/http-timer/issues/35
            if (timings.phases.tcp === 0 && timings.phases.dns && timings.phases.dns > 0) {
                timings.phases.dns = 0;
            }
            // Store connection phase timings on socket for potential reuse
            if (!getInitialConnectionTimings(socket)) {
                setInitialConnectionTimings(socket, {
                    dnsPhase: timings.phases.dns,
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TypeScript can't prove this is defined due to callback structure
                    tcpPhase: timings.phases.tcp,
                });
            }
            if ('encrypted' in socket) {
                if (socket.authorized) {
                    onSecureConnect();
                }
                else {
                    // Wait for secureConnect event (even if authorization fails, we need the timing)
                    socket.once('secureConnect', onSecureConnect);
                }
            }
        });
    };
    if (request.socket) {
        onSocket(request.socket);
    }
    else {
        request.prependOnceListener('socket', onSocket);
    }
    const onUpload = () => {
        timings.upload = Date.now();
        // Calculate request phase if we have connection timings
        const secureOrConnect = timings.secureConnect ?? timings.connect;
        if (secureOrConnect !== undefined) {
            timings.phases.request = timings.upload - secureOrConnect;
        }
        // If both are undefined (HTTP/2), phases.request stays undefined (not NaN)
    };
    if (request.writableFinished) {
        onUpload();
    }
    else {
        request.prependOnceListener('finish', onUpload);
    }
    request.prependOnceListener('response', (response) => {
        timings.response = Date.now();
        // The server may respond before the upload finishes, for example to reject a large body early. There is no first byte phase to measure then.
        if (timings.upload !== undefined) {
            timings.phases.firstByte = timings.response - timings.upload;
        }
        response.timings = timings;
        handleError(response);
        response.prependOnceListener('end', () => {
            request.off('abort', onAbort);
            response.off('aborted', onAbort);
            if (timings.phases.total !== undefined) {
                // Aborted or errored
                return;
            }
            timings.end = Date.now();
            timings.phases.download = timings.end - timings.response;
            timings.phases.total = timings.end - timings.start;
        });
        response.prependOnceListener('aborted', onAbort);
    });
    return timings;
};
/* harmony default export */ const utils_timer = (timer);

// EXTERNAL MODULE: external "node:zlib"
var external_node_zlib_ = __webpack_require__(38522);
;// CONCATENATED MODULE: ./node_modules/decompress-response/index.js




// Detect zstd support (available in Node.js >= 22.15.0)
const supportsZstd = typeof external_node_zlib_.createZstdDecompress === 'function';

function decompressResponse(response) {
	const contentEncoding = (response.headers['content-encoding'] || '').toLowerCase();
	const supportedEncodings = ['gzip', 'deflate', 'br'];
	if (supportsZstd) {
		supportedEncodings.push('zstd');
	}

	if (!supportedEncodings.includes(contentEncoding)) {
		return response;
	}

	let isEmpty = true;

	// Clone headers to avoid modifying the original response headers
	const headers = {...response.headers};

	const finalStream = new external_node_stream_.PassThrough({
		autoDestroy: false,
	});

	// Only destroy response on error, not on normal completion
	finalStream.once('error', () => {
		response.destroy();
	});

	function handleContentEncoding(data) {
		let decompressStream;

		if (contentEncoding === 'zstd') {
			decompressStream = external_node_zlib_.createZstdDecompress();
		} else if (contentEncoding === 'br') {
			decompressStream = external_node_zlib_.createBrotliDecompress();
		} else if (contentEncoding === 'deflate' && data.length > 0 && (data[0] & 0x08) === 0) { // eslint-disable-line no-bitwise
			decompressStream = external_node_zlib_.createInflateRaw();
		} else {
			decompressStream = external_node_zlib_.createUnzip();
		}

		decompressStream.once('error', error => {
			if (isEmpty && !response.readable) {
				finalStream.end();
				return;
			}

			finalStream.destroy(error);
		});

		checker.pipe(decompressStream).pipe(finalStream);
	}

	const checker = new external_node_stream_.Transform({
		transform(data, _encoding, callback) {
			if (isEmpty === false) {
				callback(null, data);
				return;
			}

			isEmpty = false;

			handleContentEncoding(data);

			callback(null, data);
		},

		flush(callback) {
			if (isEmpty) {
				finalStream.end();
			}

			callback();
		},
	});

	delete headers['content-encoding'];
	delete headers['content-length'];
	finalStream.headers = headers;

	mimicResponse(response, finalStream);

	response.pipe(checker);

	return finalStream;
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/decompress-response.js


const supportedEncodings = new Set(['gzip', 'deflate', 'br', ...(typeof external_node_zlib_.createZstdDecompress === 'function' ? ['zstd'] : [])]);
function decompressResponseBody(response) {
    const encodings = (response.headers['content-encoding'] ?? '')
        .toLowerCase()
        .split(',')
        .map(encoding => encoding.trim())
        // Empty list members are ignored (RFC 9110, section 5.6.1.1).
        .filter(encoding => encoding.length > 0)
        // `identity` means the content was not transformed, so it adds no decoding step.
        .filter(encoding => encoding !== 'identity')
        .map(encoding => encoding === 'x-gzip' ? 'gzip' : encoding);
    if (encodings.some(encoding => !supportedEncodings.has(encoding))) {
        return decompressResponse(response);
    }
    const nativeResponse = response;
    // Content-Encoding lists codings in application order (RFC 9110, section 8.4).
    for (const encoding of encodings.toReversed()) {
        const source = response;
        const originalHeaders = source.headers;
        try {
            // The dependency accepts one coding. Retain the native headers for wire-byte validation.
            source.headers = { ...originalHeaders, 'content-encoding': encoding };
            response = decompressResponse(source);
        }
        finally {
            source.headers = originalHeaders;
        }
        if (source === nativeResponse) {
            continue;
        }
        const decoded = response;
        source.once('error', error => {
            decoded.destroy(error);
        });
    }
    return response;
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/get-body-size.js


function getBodySize(body, headers) {
    if (headers && 'content-length' in headers && headers['content-length'] !== undefined) {
        return Number(headers['content-length']);
    }
    if (!body) {
        return 0;
    }
    if (distribution.string(body)) {
        return stringToUint8Array(body).byteLength;
    }
    return ArrayBuffer.isView(body) ? body.byteLength : undefined;
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/is-non-replayable-body.js

// A body is replayable only if iterating it again restarts from the beginning.
// Node streams, Web `ReadableStream`s, and iterator objects are consumed by an upload, so they cannot be replayed on a redirect or retry.
function isNonReplayableBody(body) {
    // Creating an iterator can open resources or throw. Only create it when actually sending the body.
    return distribution.nodeStream(body)
        || body instanceof ReadableStream
        || (distribution.object(body) && distribution.function(body.next));
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/proxy-events.js
function proxyEvents(from, to, events) {
    const eventFunctions = new Map();
    for (const event of events) {
        const eventFunction = (...arguments_) => {
            to.emit(event, ...arguments_);
        };
        eventFunctions.set(event, eventFunction);
        from.on(event, eventFunction);
    }
    return () => {
        for (const [event, eventFunction] of eventFunctions) {
            from.off(event, eventFunction);
        }
    };
}

// EXTERNAL MODULE: external "node:net"
var external_node_net_ = __webpack_require__(77030);
;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/timed-out.js

const reentry = Symbol('reentry');
const timed_out_noop = () => { };
class timed_out_TimeoutError extends Error {
    name = 'TimeoutError';
    code = 'ETIMEDOUT';
    event;
    constructor(threshold, event) {
        super(`Timeout awaiting '${event}' for ${threshold}ms`);
        this.event = event;
    }
}
// Node.js turns timer delays above the 32-bit limit (including `Infinity`) into 1 ms with a
// warning, so such a delay means "no timeout" instead of an instant timeout.
const maximumTimerDelay = 2_147_483_647;
/**
Whether a delay can be armed as a Node.js timer without collapsing into an instant timeout.
*/
const isArmableTimerDelay = (delay) => delay <= maximumTimerDelay && Number.isFinite(delay);
function timedOut(request, delays, options) {
    // `reentry` is a symbol, so it cannot collide with a header name, and the request object is
    // itself the marker. Rewriting either line as an `Object.hasOwn` call would check something else.
    // eslint-disable-next-line unicorn/no-computed-property-existence-check
    if (reentry in request) {
        return timed_out_noop;
    }
    request[reentry] = true;
    const cancelers = [];
    const handled = new Set();
    // When attaching listeners, it's very easy to forget about them.
    // Especially if you do error handling and set timeouts.
    // So instead of checking if it's proper to throw an error on every timeout ever,
    // track every listener attached through `once` below, so `cancelTimeouts` can remove all of them.
    const listeners = [];
    const once = (origin, event, listener) => {
        origin.once(event, listener);
        listeners.push({ origin, event, listener });
    };
    const addTimeout = (delay, event) => {
        if (!isArmableTimerDelay(delay)) {
            return timed_out_noop;
        }
        const timeout = setTimeout(timeoutHandler, delay, delay, event);
        timeout.unref();
        const cancel = () => {
            handled.add(event);
            clearTimeout(timeout);
        };
        cancelers.push(cancel);
        return cancel;
    };
    const { host, hostname } = options;
    const timeoutHandler = (delay, event) => {
        // Use setTimeout to allow for any cancelled events to be handled first,
        // to prevent firing any TimeoutError unneeded when the event loop is busy or blocked
        setTimeout(() => {
            if (!handled.has(event)) {
                request.destroy(new timed_out_TimeoutError(delay, event));
            }
        }, 0);
    };
    const cancelTimeouts = () => {
        for (const cancel of cancelers) {
            cancel();
        }
        for (const { origin, event, listener } of listeners) {
            origin.removeListener(event, listener);
        }
        listeners.length = 0;
    };
    request.once('error', error => {
        cancelTimeouts();
        // Save original behavior
        /* istanbul ignore next */
        if (request.listenerCount('error') === 0) {
            throw error;
        }
    });
    if (delays.socket !== undefined && isArmableTimerDelay(delays.socket)) {
        const { socket } = delays;
        const socketTimeoutHandler = () => {
            timeoutHandler(socket, 'socket');
        };
        request.setTimeout(socket, socketTimeoutHandler);
        // `request.setTimeout(0)` causes a memory leak.
        // We can just remove the listener and forget about the timer - it's unreffed.
        // See https://github.com/sindresorhus/got/issues/690
        cancelers.push(() => {
            handled.add('socket');
            request.removeListener('timeout', socketTimeoutHandler);
        });
    }
    const hasLookup = delays.lookup !== undefined;
    const hasConnect = delays.connect !== undefined;
    const hasSecureConnect = delays.secureConnect !== undefined;
    const hasSend = delays.send !== undefined;
    if (hasLookup || hasConnect || hasSecureConnect || hasSend) {
        const onSocket = (socket) => {
            const { socketPath } = request;
            /* istanbul ignore next: hard to test */
            if (socket.connecting) {
                // WHATWG URL hostnames keep IPv6 brackets, which `net.isIP` rejects. Strip them so IPv6 URLs skip DNS correctly.
                const normalizedHostname = hostname?.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
                const hasPath = Boolean(socketPath ?? (external_node_net_.isIP(normalizedHostname ?? host ?? '') !== 0));
                // A synchronous lookup can finish before the socket is assigned to the request.
                const hasLookupCompleted = socket.address().address !== undefined;
                if (hasLookup && !hasPath && !hasLookupCompleted) {
                    const cancelTimeout = addTimeout(delays.lookup, 'lookup');
                    once(socket, 'lookup', cancelTimeout);
                }
                if (hasConnect) {
                    const timeConnect = () => addTimeout(delays.connect, 'connect');
                    if (hasPath || hasLookupCompleted) {
                        once(socket, 'connect', timeConnect());
                    }
                    else {
                        once(socket, 'lookup', (error) => {
                            if (error === null) {
                                once(socket, 'connect', timeConnect());
                            }
                        });
                    }
                }
                if (hasSecureConnect && options.protocol === 'https:') {
                    once(socket, 'connect', () => {
                        const cancelTimeout = addTimeout(delays.secureConnect, 'secureConnect');
                        once(socket, 'secureConnect', cancelTimeout);
                    });
                }
            }
            if (hasSend) {
                const timeRequest = () => addTimeout(delays.send, 'send');
                /* istanbul ignore next: hard to test */
                if (socket.connecting) {
                    once(socket, 'connect', () => {
                        once(request, 'upload-complete', timeRequest());
                    });
                }
                else {
                    once(request, 'upload-complete', timeRequest());
                }
            }
        };
        if (request.socket) {
            onSocket(request.socket);
        }
        else {
            once(request, 'socket', onSocket);
        }
    }
    if (delays.response !== undefined) {
        let cancelTimeout = timed_out_noop;
        const startTimeout = () => {
            cancelTimeout = addTimeout(delays.response, 'response');
        };
        once(request, 'upload-complete', startTimeout);
        once(request, 'response', () => {
            // A server can respond before the upload finishes.
            request.removeListener('upload-complete', startTimeout);
            cancelTimeout();
        });
    }
    if (delays.read !== undefined) {
        once(request, 'response', (response) => {
            const cancelTimeout = addTimeout(delays.read, 'read');
            once(response, 'end', cancelTimeout);
        });
    }
    return cancelTimeouts;
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/weakable-map.js
class WeakableMap {
    weakMap = new WeakMap();
    map = new Map();
    set(key, value) {
        if (typeof key === 'object') {
            this.weakMap.set(key, value);
        }
        else {
            this.map.set(key, value);
        }
    }
    get(key) {
        return typeof key === 'object' ? this.weakMap.get(key) : this.map.get(key);
    }
    has(key) {
        return typeof key === 'object' ? this.weakMap.has(key) : this.map.has(key);
    }
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/calculate-retry-delay.js
const calculateRetryDelay = ({ attemptCount, retryOptions, error, retryAfter, computedValue, }) => {
    if (error.name === 'RetryError') {
        return 1;
    }
    if (attemptCount > retryOptions.limit) {
        return 0;
    }
    const hasMethod = retryOptions.methods.includes(error.options.method);
    const hasErrorCode = retryOptions.errorCodes.includes(error.code);
    const hasStatusCode = error.response && retryOptions.statusCodes.includes(error.response.statusCode);
    if (!hasMethod || (!hasErrorCode && !hasStatusCode)) {
        return 0;
    }
    if (error.response) {
        if (retryAfter !== undefined) {
            // In this case `computedValue` is `retryOptions.maxRetryAfter ?? options.timeout.request ?? Infinity`
            // Compare the server delay before applying the minimum nonzero retry timer.
            return retryAfter > computedValue ? 0 : Math.max(1, retryAfter);
        }
        if (error.response.statusCode === 413) {
            return 0;
        }
    }
    const noise = Math.random() * retryOptions.noise;
    // Zero disables retries, so represent an immediate retry with the minimum timer delay.
    return Math.max(1, Math.min(((2 ** (attemptCount - 1)) * 1000), retryOptions.backoffLimit) + noise);
};
/* harmony default export */ const calculate_retry_delay = (calculateRetryDelay);

// EXTERNAL MODULE: external "node:tls"
var external_node_tls_ = __webpack_require__(41692);
// EXTERNAL MODULE: external "node:https"
var external_node_https_ = __webpack_require__(44708);
;// CONCATENATED MODULE: ./node_modules/lowercase-keys/index.js
function lowercase_keys_lowercaseKeys(object, {onConflict} = {}) {
	if (typeof object !== 'object' || object === null) {
		throw new TypeError(`Expected an object, got ${object === null ? 'null' : typeof object}`);
	}

	const result = {};

	for (const [key, value] of Object.entries(object)) {
		const lowercasedKey = key.toLowerCase();
		const hasExistingKey = Object.hasOwn(result, lowercasedKey);
		const existingValue = hasExistingKey ? result[lowercasedKey] : undefined;

		const resolvedValue = onConflict && hasExistingKey
			? onConflict({key: lowercasedKey, newValue: value, existingValue})
			: value;

		Object.defineProperty(result, lowercasedKey, {
			value: resolvedValue,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	return result;
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/parse-link-header.js
const splitHeaderValue = (value, separator) => {
    const values = [];
    let current = '';
    let inQuotes = false;
    let inReference = false;
    let isEscaped = false;
    for (const character of value) {
        if (inQuotes) {
            if (isEscaped) {
                isEscaped = false;
            }
            else if (character === '\\') {
                isEscaped = true;
            }
            else if (character === '"') {
                inQuotes = false;
            }
        }
        else if (character === '"') {
            inQuotes = true;
        }
        else if (character === '<' || character === '>') {
            inReference = character === '<';
        }
        else if (!inReference && character === separator) {
            // Link headers use both quoted strings and <URI-reference> values, so raw
            // splitting on `,` / `;` would break valid values containing those characters.
            values.push(current);
            current = '';
            continue;
        }
        current += character;
    }
    if (inQuotes) {
        throw new Error(`Failed to parse Link header: ${value}`);
    }
    values.push(current);
    return values;
};
function parseLinkHeader(link) {
    const parsed = [];
    for (const item of splitHeaderValue(link, ',')) {
        // HTTP list recipients ignore empty members (RFC 9110, section 5.6.1.2).
        if (item.trim() === '') {
            continue;
        }
        // https://tools.ietf.org/html/rfc5988#section-5
        const [rawUriReference, ...rawLinkParameters] = splitHeaderValue(item, ';');
        const trimmedUriReference = rawUriReference.trim();
        // eslint-disable-next-line @typescript-eslint/prefer-string-starts-ends-with
        if (trimmedUriReference[0] !== '<' || trimmedUriReference.at(-1) !== '>') {
            throw new Error(`Invalid format of the Link header reference: ${trimmedUriReference}`);
        }
        // Optional whitespace is allowed inside the angle brackets (RFC 8288, section 3).
        const reference = trimmedUriReference.slice(1, -1).trim();
        if (reference.includes('<') || reference.includes('>')) {
            throw new Error(`Invalid format of the Link header reference: ${trimmedUriReference}`);
        }
        // Parameter names can match `Object.prototype` properties, so use a null-prototype object.
        const parameters = Object.create(null);
        for (const rawParameter of rawLinkParameters) {
            const trimmedRawParameter = rawParameter.trim();
            const center = trimmedRawParameter.indexOf('=');
            // The parameter value is optional. See https://www.rfc-editor.org/rfc/rfc8288#section-3
            const name = center === -1 ? trimmedRawParameter : trimmedRawParameter.slice(0, center).trim();
            if (name === '') {
                throw new Error(`Failed to parse Link header: ${link}`);
            }
            const value = center === -1 ? '' : trimmedRawParameter.slice(center + 1).trim();
            const normalizedName = name.toLowerCase();
            if (!Object.hasOwn(parameters, normalizedName)) {
                parameters[normalizedName] = value;
            }
        }
        parsed.push({
            reference,
            parameters,
        });
    }
    return parsed;
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/response.js



const decodedBodyCache = new WeakMap();
const redirectDecisions = new WeakMap();
// TextDecoder strips a leading byte order mark, which Buffer#toString keeps.
const bomStrippingDecoders = new Map([
    ['utf8', new TextDecoder()],
    ['utf16le', new TextDecoder('utf-16le')],
]);
const normalizeEncoding = (encoding) => (encoding ?? 'utf8').toLowerCase().replace('-', '').replace('ucs2', 'utf16le');
const isUtf8Encoding = (encoding) => normalizeEncoding(encoding) === 'utf8';
const decodeUint8Array = (data, encoding) => bomStrippingDecoders.get(normalizeEncoding(encoding))?.decode(data) ?? external_node_buffer_.Buffer.from(data).toString(encoding);
const isResponseOk = (response) => {
    const { statusCode } = response;
    if ((statusCode >= 200 && statusCode <= 299) || statusCode === 304) {
        return true;
    }
    if (statusCode < 300 || statusCode > 399) {
        return false;
    }
    const { followRedirect } = response.request.options;
    if (typeof followRedirect !== 'function') {
        return !followRedirect;
    }
    let decision = redirectDecisions.get(response);
    if (decision?.predicate !== followRedirect) {
        decision = { predicate: followRedirect, follow: followRedirect(response) };
        redirectDecisions.set(response, decision);
    }
    return !decision.follow;
};
/**
Shares the redirect decision when a response stream is wrapped for decompression.
*/
const copyRedirectDecision = (source, destination) => {
    const decision = redirectDecisions.get(source);
    if (decision !== undefined) {
        redirectDecisions.set(destination, decision);
    }
};
/**
An error to be thrown when server response code is 2xx, and parsing body fails.
Includes a `response` property.
*/
class ParseError extends RequestError {
    name = 'ParseError';
    code = 'ERR_BODY_PARSE_FAILURE';
    constructor(error, response) {
        const { options } = response.request;
        // The thrown value is kept as the cause, so only its message is normalized.
        super(`${normalizeError(error).message} in "${stripUrlAuth(options.url)}"`, error, response.request, response);
    }
}
const cacheDecodedBody = (response, decodedBody) => {
    decodedBodyCache.set(response, decodedBody);
};
const parseBody = (response, responseType, parseJson, encoding) => {
    const { rawBody } = response;
    const cachedDecodedBody = decodedBodyCache.get(response);
    // Shortcuts must read the current bytes because callers can mutate `rawBody`.
    decodedBodyCache.delete(response);
    try {
        if (responseType === 'text') {
            return cachedDecodedBody ?? decodeUint8Array(rawBody, encoding);
        }
        if (responseType === 'json') {
            if (rawBody.length === 0) {
                return '';
            }
            const text = cachedDecodedBody ?? decodeUint8Array(rawBody, encoding);
            return parseJson(text);
        }
        if (responseType === 'buffer') {
            return rawBody;
        }
    }
    catch (error) {
        // `ParseError` normalizes the message and keeps the thrown value as the cause.
        throw new ParseError(error, response);
    }
    throw new ParseError({
        message: `Unknown body type '${responseType}'`,
        name: 'Error',
    }, response);
};

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/is-unix-socket-url.js
function isUnixSocketUrl(url) {
    return url.protocol === 'unix:' || url.hostname === 'unix';
}
/**
Extract the socket path from a UNIX socket URL.

@example
```
getUnixSocketPath(new URL('http://unix/foo:/path'));
//=> '/foo'

getUnixSocketPath(new URL('unix:/foo:/path'));
//=> '/foo'

getUnixSocketPath(new URL('http://example.com'));
//=> undefined
```
*/
function getUnixSocketPath(url) {
    return isUnixSocketUrl(url) ? /^(?<socketPath>[^:]+):/v.exec(`${url.pathname}${url.search}`)?.groups?.socketPath : undefined;
}

// EXTERNAL MODULE: external "node:dns"
var external_node_dns_ = __webpack_require__(40610);
// EXTERNAL MODULE: external "node:os"
var external_node_os_ = __webpack_require__(48161);
;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/dns-cache.js




const ttl = { ttl: true };
const noResultErrorCodes = new Set(['ENODATA', 'ENOTFOUND', 'ENOENT']);
const maximumCacheTtl = Math.floor(2_147_483_647 / 1000);
const isPromiseLike = (value) => typeof value?.then === 'function';
const now = () => Date.now();
const hasUnexpired = (cache, key) => {
    const expires = cache.get(key);
    if (expires === undefined) {
        return false;
    }
    if (expires <= now()) {
        cache.delete(key);
        return false;
    }
    return true;
};
const deleteExpiredMapEntries = (cache, time = now()) => {
    for (const [key, expires] of cache) {
        if (expires <= time) {
            cache.delete(key);
        }
    }
};
// eslint-disable-next-line no-bitwise
const hasFlag = (value, flag) => value !== undefined && (value & flag) === flag;
const getConfiguredFamilies = () => {
    const families = new Set();
    for (const networkInterface of Object.values(external_node_os_.networkInterfaces())) {
        for (const address of networkInterface ?? []) {
            if (!address.internal) {
                families.add(address.family === 'IPv6' ? 6 : 4);
            }
        }
    }
    return families;
};
const createNoResultError = (hostname) => {
    const error = new Error(`DNS cache lookup ENOTFOUND ${hostname}`);
    error.code = 'ENOTFOUND';
    error.hostname = hostname;
    return error;
};
// Caller mutations must not change an in-flight lookup or its callback shape.
const normalizeLookupOptions = (options) => typeof options === 'number' ? { family: options } : { ...options };
const normalizeResolverRecord = (record, family, maxTtl) => {
    // A record without a usable TTL must expire immediately. A `NaN` expiry would never
    // elapse, which caches the address forever.
    const recordTtl = record.ttl;
    const entryTtl = Number.isFinite(recordTtl) ? Math.min(recordTtl, maxTtl) : 0;
    return {
        address: record.address,
        family,
        expires: now() + (entryTtl * 1000),
    };
};
const map4To6 = (entries) => entries.map(entry => {
    if (entry.family === 6) {
        return entry;
    }
    return {
        ...entry,
        address: `::ffff:${entry.address}`,
        family: 6,
    };
});
const familyFromOptions = (options) => {
    if (options.family === 4 || options.family === 6) {
        return options.family;
    }
    if (options.family === 'IPv4') {
        return 4;
    }
    return options.family === 'IPv6' ? 6 : undefined;
};
const orderFromOptions = (options) => {
    if (options.order !== undefined) {
        return options.order;
    }
    if (options.verbatim !== undefined) {
        return options.verbatim ? 'verbatim' : 'ipv4first';
    }
    return (0,external_node_dns_.getDefaultResultOrder)();
};
const familiesFromOptions = (options) => {
    const family = familyFromOptions(options);
    if (family === 6 && hasFlag(options.hints, external_node_dns_.V4MAPPED) && hasFlag(options.hints, external_node_dns_.ALL)) {
        return [6, 4];
    }
    if (family !== undefined) {
        return [family];
    }
    return orderFromOptions(options) === 'ipv6first' ? [6, 4] : [4, 6];
};
const filterFamiliesByAddrConfig = (families, options) => {
    if (!hasFlag(options.hints, external_node_dns_.ADDRCONFIG)) {
        return families;
    }
    const configuredFamilies = getConfiguredFamilies();
    return families.filter(family => configuredFamilies.has(family));
};
const shouldQueryMappedIpv4 = (entries, options) => familyFromOptions(options) === 6
    && hasFlag(options.hints, external_node_dns_.V4MAPPED)
    && !hasFlag(options.hints, external_node_dns_.ALL)
    && entries.every(entry => entry.family !== 6);
const cacheKey = (hostname, family) => `${hostname}:${family}`;
const lookupOptionsKey = (hostname, options) => `${hostname}:${familyFromOptions(options) ?? 0}:${options.hints ?? 0}:${orderFromOptions(options)}`;
const shouldIgnoreResolveError = (error) => error.code !== undefined && noResultErrorCodes.has(error.code);
const toLookupResult = ({ address, family }) => ({
    address,
    family,
});
class DnsCache {
    lookup;
    #cache;
    #resolver;
    #dnsLookupAsync;
    #cacheKeys = new Set();
    #pending = new Map();
    #pendingFallback = new Map();
    #lookupOptionsToFallback = new Map();
    #lookupOptionsWithoutFallback = new Map();
    #maxTtl;
    #fallbackDuration;
    #errorTtl;
    #minimumVersionByHostname = new Map();
    #activeQueriesByHostname = new Map();
    #minimumVersion = 0;
    #clearVersion = 0;
    constructor({ cache = new Map(), maxTtl = maximumCacheTtl, fallbackDuration = 3600, errorTtl = 0.15, resolver = new external_node_dns_.promises.Resolver(), lookup = external_node_dns_.lookup, } = {}) {
        this.#cache = cache;
        this.#resolver = resolver;
        this.#maxTtl = Math.min(maxTtl, maximumCacheTtl);
        this.#fallbackDuration = fallbackDuration;
        this.#errorTtl = errorTtl;
        this.#dnsLookupAsync = lookup === false ? undefined : (0,external_node_util_.promisify)(lookup);
        this.lookup = this.#lookup.bind(this);
    }
    async lookupAsync(hostname, options) {
        const normalizedOptions = normalizeLookupOptions(options);
        const literalFamily = (0,external_node_net_.isIP)(hostname);
        if (literalFamily !== 0) {
            const entries = [{
                    address: hostname,
                    family: literalFamily,
                }];
            return normalizedOptions.all ? entries : entries[0];
        }
        let entries = await this.#query(hostname, normalizedOptions);
        entries = this.#filterEntries(entries, normalizedOptions);
        if (entries.length === 0) {
            throw createNoResultError(hostname);
        }
        const lookupResults = entries.map(entry => toLookupResult(entry));
        return normalizedOptions.all ? lookupResults : lookupResults[0];
    }
    clear(hostname) {
        this.#clearVersion++;
        if (hostname === undefined) {
            this.#minimumVersion = this.#clearVersion;
            this.#minimumVersionByHostname.clear();
            for (const key of this.#cacheKeys) {
                this.#cache.delete(key);
            }
            this.#cacheKeys.clear();
            this.#pending.clear();
            this.#pendingFallback.clear();
            this.#lookupOptionsToFallback.clear();
            this.#lookupOptionsWithoutFallback.clear();
            return;
        }
        for (const family of [4, 6]) {
            const key = cacheKey(hostname, family);
            this.#deleteCacheEntry(key);
            this.#pending.delete(key);
        }
        if (this.#activeQueriesByHostname.has(hostname)) {
            this.#minimumVersionByHostname.set(hostname, this.#clearVersion);
        }
        for (const map of [this.#pendingFallback, this.#lookupOptionsToFallback, this.#lookupOptionsWithoutFallback]) {
            for (const key of map.keys()) {
                if (key.startsWith(`${hostname}:`)) {
                    map.delete(key);
                }
            }
        }
    }
    #lookup(hostname, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        if (callback === undefined) {
            throw new Error('Callback must be a function.');
        }
        const normalizedOptions = normalizeLookupOptions(options);
        void this.#lookupAndCallback(hostname, normalizedOptions, callback);
    }
    async #lookupAndCallback(hostname, options, callback) {
        let result;
        try {
            result = await this.lookupAsync(hostname, options);
        }
        catch (error) {
            queueMicrotask(() => {
                const callbackWithError = callback;
                callbackWithError(error);
            });
            return;
        }
        queueMicrotask(() => {
            if (options.all) {
                callback(null, result);
                return;
            }
            const entry = result;
            callback(null, entry.address, entry.family);
        });
    }
    async #query(hostname, options) {
        this.#activeQueriesByHostname.set(hostname, (this.#activeQueriesByHostname.get(hostname) ?? 0) + 1);
        try {
            const lookupOptionKey = lookupOptionsKey(hostname, options);
            if (hasUnexpired(this.#lookupOptionsToFallback, lookupOptionKey)) {
                return await this.#fallbackLookupOnce(hostname, options, lookupOptionKey);
            }
            let families = filterFamiliesByAddrConfig(familiesFromOptions(options), options);
            const clearVersion = this.#clearVersion;
            let flattenedEntries = await this.#queryFamilies(hostname, families, clearVersion);
            if (shouldQueryMappedIpv4(flattenedEntries, options) && !families.includes(4)) {
                families = filterFamiliesByAddrConfig([4], options);
                flattenedEntries = await this.#queryFamilies(hostname, families, clearVersion);
            }
            if (flattenedEntries.length > 0 || this.#dnsLookupAsync === undefined) {
                return flattenedEntries;
            }
            if (hasUnexpired(this.#lookupOptionsWithoutFallback, lookupOptionKey)) {
                return [];
            }
            const fallbackEntries = await this.#fallbackLookupOnce(hostname, options, lookupOptionKey);
            if (!this.#isVersionCurrent(hostname, clearVersion)) {
                return fallbackEntries;
            }
            this.#deleteExpiredFallbackState();
            if (fallbackEntries.length > 0 && this.#fallbackDuration > 0) {
                this.#lookupOptionsToFallback.set(lookupOptionKey, now() + (this.#fallbackDuration * 1000));
            }
            else if (fallbackEntries.length === 0 && this.#errorTtl > 0) {
                this.#lookupOptionsWithoutFallback.set(lookupOptionKey, now() + (this.#errorTtl * 1000));
            }
            return fallbackEntries;
        }
        finally {
            this.#finishQuery(hostname);
        }
    }
    #finishQuery(hostname) {
        const activeQueryCount = this.#activeQueriesByHostname.get(hostname);
        if (activeQueryCount === undefined) {
            return;
        }
        if (activeQueryCount > 1) {
            this.#activeQueriesByHostname.set(hostname, activeQueryCount - 1);
            return;
        }
        this.#activeQueriesByHostname.delete(hostname);
        this.#minimumVersionByHostname.delete(hostname);
    }
    #deleteExpiredFallbackState() {
        const time = now();
        deleteExpiredMapEntries(this.#lookupOptionsToFallback, time);
        deleteExpiredMapEntries(this.#lookupOptionsWithoutFallback, time);
    }
    async #queryFamilies(hostname, families, clearVersion) {
        if (families.length === 1) {
            return this.#queryFamily(hostname, families[0], clearVersion);
        }
        const results = await Promise.allSettled(families.map(family => this.#queryFamily(hostname, family, clearVersion)));
        const entries = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
        if (entries.length > 0) {
            return entries;
        }
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected !== undefined) {
            if (rejected.reason instanceof Error) {
                throw rejected.reason;
            }
            throw new Error(String(rejected.reason));
        }
        return [];
    }
    async #queryFamily(hostname, family, clearVersion) {
        const key = cacheKey(hostname, family);
        const cached = await this.#getCachedFamily(key, hostname);
        if (cached !== undefined) {
            return cached.entries;
        }
        if (!this.#isVersionCurrent(hostname, clearVersion)) {
            return this.#resolveAndCache(hostname, family, clearVersion);
        }
        const pending = this.#pending.get(key);
        if (pending !== undefined) {
            return pending;
        }
        const promise = this.#resolveAndCache(hostname, family, clearVersion);
        this.#pending.set(key, promise);
        try {
            return await promise;
        }
        finally {
            if (this.#pending.get(key) === promise) {
                this.#pending.delete(key);
            }
        }
    }
    async #getCachedFamily(key, hostname) {
        let cached = this.#cache.get(key);
        if (isPromiseLike(cached)) {
            cached = await cached;
        }
        if (cached === undefined) {
            return undefined;
        }
        if (!this.#isVersionCurrent(hostname, cached.clearVersion)) {
            return undefined;
        }
        if (cached.expires <= now()) {
            this.#deleteCacheEntry(key);
            return undefined;
        }
        return cached;
    }
    async #resolveAndCache(hostname, family, clearVersion) {
        const entries = await this.#resolveFamily(hostname, family);
        if (!this.#isVersionCurrent(hostname, clearVersion)) {
            return entries;
        }
        let expires = this.#expiresFor(entries);
        if (expires === undefined && entries.length === 0 && this.#errorTtl > 0) {
            expires = now() + (this.#errorTtl * 1000);
        }
        if (expires !== undefined) {
            await this.#setCachedFamily(cacheKey(hostname, family), hostname, { entries, expires }, clearVersion);
        }
        return entries;
    }
    async #setCachedFamily(key, hostname, cached, clearVersion) {
        if (!this.#isVersionCurrent(hostname, clearVersion)) {
            return;
        }
        await this.#deleteExpiredCacheEntries();
        await this.#cache.set(key, {
            ...cached,
            clearVersion,
        });
        this.#cacheKeys.add(key);
        if (this.#isVersionCurrent(hostname, clearVersion)) {
            return;
        }
        let current = this.#cache.get(key);
        if (isPromiseLike(current)) {
            current = await current;
        }
        if (current?.clearVersion === clearVersion && !this.#isVersionCurrent(hostname, current.clearVersion)) {
            this.#deleteCacheEntry(key);
        }
    }
    async #deleteExpiredCacheEntries() {
        const time = now();
        await Promise.all([...this.#cacheKeys].map(async (key) => this.#deleteExpiredCacheEntry(key, time)));
    }
    async #deleteExpiredCacheEntry(key, time) {
        let cached = this.#cache.get(key);
        if (isPromiseLike(cached)) {
            cached = await cached;
        }
        if (cached === undefined) {
            this.#cacheKeys.delete(key);
            return;
        }
        if (cached.expires > time) {
            return;
        }
        let current = this.#cache.get(key);
        if (isPromiseLike(current)) {
            current = await current;
        }
        if (current?.clearVersion === cached.clearVersion && current.expires === cached.expires) {
            this.#deleteCacheEntry(key);
        }
    }
    #deleteCacheEntry(key) {
        this.#cache.delete(key);
        this.#cacheKeys.delete(key);
    }
    #isVersionCurrent(hostname, clearVersion) {
        const minimumVersion = this.#minimumVersionByHostname.get(hostname) ?? this.#minimumVersion;
        return clearVersion >= minimumVersion;
    }
    async #resolveFamily(hostname, family) {
        try {
            const records = family === 4
                ? await this.#resolver.resolve4(hostname, ttl)
                : await this.#resolver.resolve6(hostname, ttl);
            return records.map(record => normalizeResolverRecord(record, family, this.#maxTtl));
        }
        catch (error) {
            if (shouldIgnoreResolveError(error)) {
                return [];
            }
            throw error;
        }
    }
    #expiresFor(entries) {
        let expires = Infinity;
        for (const entry of entries) {
            if (entry.expires === undefined) {
                continue;
            }
            expires = Math.min(expires, entry.expires);
        }
        return expires === Infinity ? undefined : expires;
    }
    #filterEntries(entries, options) {
        if (hasFlag(options.hints, external_node_dns_.ADDRCONFIG)) {
            const configuredFamilies = getConfiguredFamilies();
            entries = entries.filter(entry => configuredFamilies.has(entry.family));
        }
        const family = familyFromOptions(options);
        if (family === 6) {
            const ipv6Entries = entries.filter(entry => entry.family === 6);
            if (hasFlag(options.hints, external_node_dns_.V4MAPPED)) {
                entries = hasFlag(options.hints, external_node_dns_.ALL) || ipv6Entries.length === 0
                    ? map4To6(entries)
                    : ipv6Entries;
            }
            else {
                entries = ipv6Entries;
            }
        }
        else if (family === 4) {
            entries = entries.filter(entry => entry.family === 4);
        }
        return entries;
    }
    async #fallbackLookupOnce(hostname, options, key) {
        const pending = this.#pendingFallback.get(key);
        if (pending !== undefined) {
            return pending;
        }
        const promise = this.#fallbackLookup(hostname, options);
        this.#pendingFallback.set(key, promise);
        try {
            return await promise;
        }
        finally {
            if (this.#pendingFallback.get(key) === promise) {
                this.#pendingFallback.delete(key);
            }
        }
    }
    async #fallbackLookup(hostname, options) {
        if (this.#dnsLookupAsync === undefined) {
            return [];
        }
        let result;
        try {
            result = await this.#dnsLookupAsync(hostname, {
                ...options,
                all: true,
            });
        }
        catch (error) {
            if (shouldIgnoreResolveError(error)) {
                return [];
            }
            throw error;
        }
        // Only `dns.lookup` honours `all`, so a custom lookup can resolve with a single address.
        const entries = Array.isArray(result) ? result : [{ address: result, family: (0,external_node_net_.isIP)(result) }];
        return entries.map(entry => toLookupResult(entry));
    }
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/http2-client.js
/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-restricted-types, @typescript-eslint/no-deprecated -- These come from Node's own type definitions, which the lint would otherwise reject here. */











const { HTTP2_HEADER_AUTHORITY, HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_SCHEME, HTTP2_HEADER_STATUS, HTTP2_METHOD_CONNECT, NGHTTP2_CANCEL, NGHTTP2_NO_ERROR, } = external_node_http2_.constants;
const maxProtocolCacheSize = 100;
const protocolCache = new Map();
const referenceIds = new WeakMap();
let nextReferenceId = 0;
const connectionSpecificHeaders = new Set([
    'connection',
    'http2-settings',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
]);
const normalizeRequestHeaderName = (name) => name.toLowerCase() === 'host' ? HTTP2_HEADER_AUTHORITY : name.toLowerCase();
const isPseudoHeader = (name) => name.startsWith(':');
const getConnectionHeaderTokens = (value) => {
    if (value === undefined) {
        return [];
    }
    const values = Array.isArray(value) ? value : [value];
    const tokens = [];
    for (const item of values) {
        for (const token of String(item).split(',')) {
            const normalizedToken = token.trim().toLowerCase();
            if (normalizedToken.length > 0) {
                tokens.push(normalizedToken);
            }
        }
    }
    return tokens;
};
const isTrailersTeHeader = (value) => {
    if (value === undefined) {
        return true;
    }
    return Array.isArray(value) ? value.length === 1 && value[0].trim().toLowerCase() === 'trailers' : String(value).trim().toLowerCase() === 'trailers';
};
const isConnectionHeader = (lowercasedName) => lowercasedName === 'connection' || lowercasedName === 'proxy-connection';
// HTTP/2 forbids connection-specific fields, the fields a `connection` header nominates, and any `te` value other than `trailers`.
const isDroppedHeader = (lowercasedName, value, connectionHeaderNames) => connectionSpecificHeaders.has(lowercasedName)
    || connectionHeaderNames.has(lowercasedName)
    || (lowercasedName === 'te' && !isTrailersTeHeader(value));
const setProtocolCache = (key, value) => {
    if (!protocolCache.has(key) && protocolCache.size >= maxProtocolCacheSize) {
        protocolCache.delete(protocolCache.keys().next().value);
    }
    protocolCache.set(key, value);
};
const getReferenceId = (value) => {
    let referenceId = referenceIds.get(value);
    if (referenceId === undefined) {
        referenceId = nextReferenceId++;
        referenceIds.set(value, referenceId);
    }
    return referenceId;
};
const http2_client_isPlainObject = (value) => {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};
const serializeSessionOption = (value) => {
    if (value === undefined) {
        return ['undefined'];
    }
    if (value === null) {
        return ['null'];
    }
    if (typeof value === 'function') {
        return ['function', getReferenceId(value)];
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return [typeof value, value];
    }
    if (typeof value === 'bigint') {
        return ['bigint', value.toString()];
    }
    if (typeof value === 'symbol') {
        return ['symbol', value.description];
    }
    if (Array.isArray(value)) {
        return ['array', value.map(item => serializeSessionOption(item))];
    }
    if (typeof value === 'object') {
        if (ArrayBuffer.isView(value)) {
            return ['bytes', external_node_buffer_.Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')];
        }
        return http2_client_isPlainObject(value) ? ['object', Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, serializeSessionOption(item)])] : ['object-reference', getReferenceId(value)];
    }
    return [typeof value];
};
const serializeSessionOptions = (values) => JSON.stringify(values.map(value => serializeSessionOption(value)));
const getTlsSessionOptions = (options) => [
    options.ca,
    options.cert,
    options.key,
    options.pfx,
    options.rejectUnauthorized,
    options.servername,
    options.localAddress,
    options.lookup,
    options.family,
    options.minVersion,
    options.maxVersion,
    options.ciphers,
    options.honorCipherOrder,
    options.checkServerIdentity,
    options.passphrase,
    options.sigalgs,
    options.sessionTimeout,
    options.dhparam,
    options.ecdhCurve,
    options.crl,
    options.secureOptions,
    options.secureContext,
    options.secureProtocol,
];
const destroyReuseSocket = (options) => {
    options._reuseSocket?.destroy();
    delete options._reuseSocket;
    delete options._reuseSocketShouldPool;
};
const onceConnected = (socket, listener) => {
    if (socket.connecting) {
        socket.once('connect', listener);
    }
    else {
        listener();
    }
};
const canPoolSession = (options) => options._reuseSocket === undefined || options._reuseSocketShouldPool === true;
const rejectQueueEntry = (entry, error) => {
    delete entry.options._cancelSessionSetup;
    destroyReuseSocket(entry.options);
    entry.reject(error);
};
const normalizeInput = (input, options, callback) => {
    let normalizedOptions;
    if (typeof input === 'string') {
        normalizedOptions = (0,external_node_url_.urlToHttpOptions)(new URL(input));
    }
    else if (input instanceof URL) {
        normalizedOptions = (0,external_node_url_.urlToHttpOptions)(input);
    }
    else {
        normalizedOptions = { ...input };
    }
    if (typeof options === 'function' || options === undefined) {
        callback = options;
    }
    else {
        normalizedOptions = {
            ...normalizedOptions,
            ...options,
        };
    }
    return { options: normalizedOptions, callback };
};
const stripIpv6Brackets = (hostname) => hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
const getAuthority = (options) => {
    const protocol = options.protocol ?? 'https:';
    const defaultPort = protocol === 'https:' ? 443 : 80;
    if (options.hostname === undefined && options.host !== undefined) {
        try {
            const authority = new URL(`${protocol}//${options.host}`);
            const port = options.port ?? authority.port;
            authority.port = String(port === '' ? defaultPort : port);
            return authority;
        }
        catch {
            // Fall back to hostname normalization for values like bare IPv6 addresses.
        }
    }
    const port = options.port ?? defaultPort;
    const normalizedHostname = stripIpv6Brackets(options.hostname ?? options.host ?? 'localhost');
    const formattedHostname = external_node_net_.isIP(normalizedHostname) === 6 ? `[${normalizedHostname}]` : normalizedHostname;
    const authority = new URL(`${protocol}//${formattedHostname}`);
    authority.port = String(port);
    return authority;
};
const getAuthorityPort = (authority) => {
    if (authority.port !== '') {
        return Number(authority.port);
    }
    return authority.protocol === 'https:' ? 443 : 80;
};
const hasCustomHttpsAgent = (agent) => typeof agent === 'object'
    && 'https' in agent
    && agent.https !== undefined
    && agent.https !== false;
const getProtocolCacheKey = (options) => {
    const authority = getAuthority(options);
    const protocols = (options.ALPNProtocols ?? ['h2', 'http/1.1']).join(',');
    return serializeSessionOptions([
        authority.host,
        protocols,
        ...getTlsSessionOptions(options),
    ]);
};
const resolveProtocol = async (options, sourceOptions) => {
    const cacheKey = getProtocolCacheKey(options);
    const cachedProtocol = options.createConnection ? undefined : protocolCache.get(cacheKey);
    if (cachedProtocol !== undefined) {
        return { alpnProtocol: cachedProtocol };
    }
    const authority = getAuthority(options);
    const { path: _path, agent: _agent, h2session: _h2session, _reuseSocket, _reuseSocketShouldPool, _alpnSocket, _socketTimeout, _timeoutPhase: timeoutPhase, timeout, createConnection, checkServerIdentity, 
    // The socket outlives this request when the session is pooled, so the signal must
    // not be handed to the TLS connect. Aborting during setup is handled below.
    signal: _signal, ...connectionOptions } = options;
    const port = getAuthorityPort(authority);
    const hostname = stripIpv6Brackets(authority.hostname);
    const servername = options.servername ?? (external_node_net_.isIP(hostname) === 0 ? hostname : undefined);
    const tlsOptions = {
        ...connectionOptions,
        ALPNProtocols: options.ALPNProtocols ?? ['h2', 'http/1.1'],
        host: hostname,
        port,
        servername,
        ...(checkServerIdentity && { checkServerIdentity: checkServerIdentity }),
    };
    const socket = createConnection
        ? createConnection(tlsOptions, () => { })
        : external_node_tls_.connect(port, hostname, tlsOptions);
    options._alpnSocket = socket;
    sourceOptions._alpnSocket = socket;
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId;
        let removeAbortListener;
        let socketTimeoutApplied = false;
        const cleanup = () => {
            clearTimeout(timeoutId);
            removeAbortListener?.();
            socket.off('secureConnect', onSecureConnect);
            socket.off('error', rejectOnce);
            socket.off('close', onClose);
            socket.off('connect', applySocketTimeout);
            socket.off('timeout', onSocketTimeout);
            if (socketTimeoutApplied) {
                socket.setTimeout(0);
            }
            delete options._alpnSocket;
            delete sourceOptions._alpnSocket;
        };
        const rejectOnce = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            socket.destroy();
            reject(error);
        };
        const onSecureConnect = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            const alpnProtocol = socket.alpnProtocol ?? false;
            if (!options.createConnection) {
                setProtocolCache(cacheKey, alpnProtocol);
            }
            resolve({ alpnProtocol, socket });
        };
        const onTimeout = () => {
            rejectOnce(new timed_out_TimeoutError(Number(timeout), timeoutPhase ?? 'request'));
        };
        const onSocketTimeout = () => {
            rejectOnce(new timed_out_TimeoutError(_socketTimeout, 'socket'));
        };
        const applySocketTimeout = () => {
            // A delay Node.js cannot arm means no socket timeout.
            if (!isArmableTimerDelay(_socketTimeout)) {
                return;
            }
            socketTimeoutApplied = true;
            socket.setTimeout(_socketTimeout);
            socket.once('timeout', onSocketTimeout);
        };
        const onClose = () => {
            const error = new Error('The HTTP/2 ALPN socket closed before negotiation completed');
            error.code = 'ECONNRESET';
            rejectOnce(error);
        };
        const onAbort = () => {
            const error = new Error('This operation was aborted.');
            error.name = 'AbortError';
            error.code = 'ERR_ABORTED';
            rejectOnce(error);
        };
        if (options.signal?.aborted) {
            onAbort();
            return;
        }
        socket.once('secureConnect', onSecureConnect);
        socket.once('error', rejectOnce);
        socket.once('close', onClose);
        if (_socketTimeout !== undefined) {
            onceConnected(socket, applySocketTimeout);
        }
        if (options.signal) {
            options.signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => {
                options.signal?.removeEventListener('abort', onAbort);
            };
        }
        if (timeout !== undefined) {
            timeoutId = setTimeout(onTimeout, timeout);
            timeoutId.unref();
        }
    });
};
const toRawHeaders = (headers) => {
    const rawHeaders = [];
    for (const [key, value] of Object.entries(headers)) {
        if (key.startsWith(':') || value === undefined) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                rawHeaders.push(key, item);
            }
        }
        else {
            rawHeaders.push(key, value);
        }
    }
    return rawHeaders;
};
const filterRawHeaders = (rawHeaders) => {
    const filteredHeaders = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const key = rawHeaders[index];
        if (key.startsWith(':')) {
            continue;
        }
        filteredHeaders.push(key, rawHeaders[index + 1]);
    }
    return filteredHeaders;
};
const filterHeaders = (headers) => {
    const filteredHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
        if (key.startsWith(':') || value === undefined) {
            continue;
        }
        filteredHeaders[key] = value;
    }
    return filteredHeaders;
};
const toDistinctHeaders = (rawHeaders) => {
    const headers = Object.create(null);
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index].toLowerCase();
        // Preserve individual field values, including commas within a single value.
        (headers[name] ??= []).push(rawHeaders[index + 1]);
    }
    return headers;
};
const createSocketProxy = (stream) => new Proxy(stream.session.socket, {
    get(target, property, receiver) {
        if (property === 'destroy') {
            return stream.destroy.bind(stream);
        }
        if (property === 'destroyed') {
            return stream.destroyed;
        }
        return property === 'setTimeout' ? stream.setTimeout.bind(stream) : Reflect.get(target, property, receiver);
    },
});
class Http2IncomingMessage extends external_node_stream_.Readable {
    stream;
    req;
    constructor(stream, request_, highWaterMark) {
        super({
            autoDestroy: true,
            emitClose: false,
            highWaterMark,
        });
        this.stream = stream;
        this.req = request_;
        this.socket = request_.socket;
    }
    aborted = false;
    httpVersion = '2.0';
    httpVersionMajor = 2;
    httpVersionMinor = 0;
    complete = false;
    rawHeaders = [];
    rawTrailers = [];
    headers = {};
    headersDistinct = {};
    trailers = {};
    trailersDistinct = {};
    statusCode;
    statusMessage;
    socket;
    url = '';
    method;
    upgrade = false;
    receivedSize = 0;
    get isCompleteAfterNoErrorReset() {
        // The reset pushes its own EOF only after the `aborted` event, so a response that already
        // completed received END_STREAM first.
        if (this.complete) {
            return true;
        }
        const statusCode = this.statusCode ?? 0;
        if (this.req.method === 'HEAD' || (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 205 || statusCode === 304) {
            return true;
        }
        const contentLength = this.headers['content-length'];
        if (typeof contentLength !== 'string' || !/^\d+$/v.test(contentLength)) {
            return false;
        }
        const expectedSize = Number(contentLength);
        return Number.isSafeInteger(expectedSize) && expectedSize === this.receivedSize + this.stream.readableLength;
    }
    get connection() {
        return this.socket;
    }
    set connection(value) {
        this.socket = value;
    }
    setTimeout(ms, callback) {
        if (callback) {
            this.once('timeout', callback);
        }
        this.req.setTimeout(ms);
        return this;
    }
    _destroy(error, callback) {
        if (!this.readableEnded && !this.aborted) {
            this.aborted = true;
            // A destroy error settles the request itself. Without one, only `aborted` does, because
            // the stream `close` handler skips a response that is already aborted.
            if (!error) {
                this.emit('aborted');
            }
        }
        this.stream.destroy(error ?? undefined);
        callback(error);
    }
    _read() {
        this.stream.resume();
    }
    _dump() {
        this.removeAllListeners('data');
        this.resume();
    }
}
class Http2Agent extends external_node_events_.EventEmitter {
    timeout;
    maxSessions;
    maxEmptySessions;
    sessions = new Map();
    pendingSessions = new Set();
    pendingSessionKeys = new Set();
    queue = [];
    emptySessionCount = 0;
    sessionCount = 0;
    settings = {
        enablePush: false,
        initialWindowSize: 1024 * 1024 * 32,
    };
    constructor({ timeout = 0, maxSessions = Infinity, maxEmptySessions = 10 } = {}) {
        super();
        this.timeout = timeout;
        this.maxSessions = maxSessions;
        this.maxEmptySessions = maxEmptySessions;
    }
    get protocol() {
        return 'https:';
    }
    async request(origin, options, headers, streamOptions) {
        const { session, reusedSocket } = await this.getSessionWithMetadata(origin, options, true);
        return {
            stream: session.request(headers, streamOptions),
            reusedSocket,
        };
    }
    async getSession(origin, options = {}) {
        const { session } = await this.getSessionWithMetadata(origin, options);
        return session;
    }
    async getSessionWithMetadata(origin, options = {}, reserveStream = false) {
        const normalizedOrigin = typeof origin === 'string' ? new URL(origin) : origin;
        const session = this.claimAvailableSession(this.normalizeOptions(normalizedOrigin, options), options, reserveStream);
        if (session) {
            return {
                session,
                reusedSocket: true,
            };
        }
        return new Promise((resolve, reject) => {
            const entry = {
                origin: normalizedOrigin,
                options,
                reserveStream,
                resolve,
                reject,
            };
            options._cancelSessionSetup = () => {
                const index = this.queue.indexOf(entry);
                if (index !== -1) {
                    this.queue.splice(index, 1);
                    rejectQueueEntry(entry, new Error('HTTP/2 session setup canceled'));
                }
            };
            this.queue.push(entry);
            this.processQueue();
        });
    }
    normalizeOptions(origin, options = {}) {
        return serializeSessionOptions([
            origin.origin,
            ...getTlsSessionOptions(options),
        ]);
    }
    closeEmptySessions(maxCount = Infinity) {
        let closedCount = 0;
        for (const sessions of this.sessions.values()) {
            for (const session of sessions) {
                if ((session.currentStreamCount ?? 0) !== 0) {
                    continue;
                }
                closedCount++;
                session.close();
                if (closedCount >= maxCount) {
                    return closedCount;
                }
            }
        }
        return closedCount;
    }
    destroy(reason) {
        for (const sessions of this.sessions.values()) {
            for (const session of sessions) {
                session.destroy(reason);
            }
        }
        for (const session of this.pendingSessions) {
            session.destroy(reason);
        }
        this.sessions.clear();
        this.pendingSessionKeys.clear();
        while (this.queue.length > 0) {
            rejectQueueEntry(this.queue.shift(), reason ?? new Error('Agent has been destroyed'));
        }
    }
    // Takes an available pooled session for the request, and drops the socket it would otherwise have reused.
    claimAvailableSession(key, options, reserveStream) {
        const session = canPoolSession(options) ? this.getAvailableSession(key) : undefined;
        if (session) {
            if (reserveStream) {
                this.reserveStream(session);
            }
            destroyReuseSocket(options);
        }
        return session;
    }
    getAvailableSession(key) {
        const sessions = this.sessions.get(key);
        if (!sessions) {
            return;
        }
        return sessions.find(session => !session.destroyed
            && !session.closed
            && !session.gracefullyClosing
            && (session.currentStreamCount ?? 0) < (session.remoteSettings.maxConcurrentStreams ?? 100));
    }
    processQueue() {
        let index = 0;
        while (index < this.queue.length) {
            const entry = this.queue[index];
            const key = this.normalizeOptions(entry.origin, entry.options);
            const session = this.claimAvailableSession(key, entry.options, entry.reserveStream);
            if (session) {
                this.queue.splice(index, 1);
                delete entry.options._cancelSessionSetup;
                entry.resolve({
                    session,
                    reusedSocket: true,
                });
                continue;
            }
            const canUsePooledSession = canPoolSession(entry.options);
            if (canUsePooledSession && this.pendingSessionKeys.has(key)) {
                index++;
                continue;
            }
            if (this.sessionCount >= this.maxSessions) {
                this.closeEmptySessions(this.sessionCount - this.maxSessions + 1);
                if (this.sessionCount >= this.maxSessions) {
                    index++;
                    continue;
                }
            }
            this.queue.splice(index, 1);
            if (canUsePooledSession) {
                this.pendingSessionKeys.add(key);
            }
            this.createSession(entry, key);
        }
    }
    // `isCapacityReservation` is false when the capacity was not reserved ahead of time, so
    // the stream is only counted. Reserving again would strand the reservation.
    reserveStream(session, isCapacityReservation = true) {
        session.ref();
        if (session.currentStreamCount === 0 && session.emptySessionCounted) {
            this.emptySessionCount--;
            session.emptySessionCounted = false;
        }
        session.currentStreamCount = (session.currentStreamCount ?? 0) + 1;
        if (isCapacityReservation) {
            session.reservedStreamCount = (session.reservedStreamCount ?? 0) + 1;
        }
    }
    releaseStream(session, shouldPoolSession) {
        session.currentStreamCount = session.currentStreamCount - 1;
        if (session.currentStreamCount === 0) {
            if (!shouldPoolSession) {
                session.close();
                this.processQueue();
                return;
            }
            this.emptySessionCount++;
            session.emptySessionCounted = true;
            session.unref();
            if (this.emptySessionCount > this.maxEmptySessions || session.gracefullyClosing) {
                session.close();
                return;
            }
        }
        this.processQueue();
    }
    createSession(entry, key) {
        this.sessionCount++;
        const { path: _path, agent: _agent, h2session: _h2session, _reuseSocketShouldPool, _socketTimeout, _timeoutPhase: timeoutPhase, timeout: setupTimeout, 
        // The session is pooled, so a per-request signal must not tear it down for the
        // requests that follow. Got aborts its own request instead.
        signal: _signal, ...sessionOptions } = entry.options;
        const options = {
            ...sessionOptions,
            settings: entry.options.settings ?? this.settings,
            ALPNProtocols: ['h2'],
        };
        const reuseSocket = options._reuseSocket;
        const shouldPoolSession = canPoolSession(entry.options);
        if (reuseSocket) {
            options.createConnection = () => reuseSocket;
            delete options._reuseSocket;
        }
        let session;
        try {
            session = external_node_http2_.connect(entry.origin, options);
        }
        catch (error) {
            this.sessionCount--;
            this.pendingSessionKeys.delete(key);
            rejectQueueEntry(entry, error);
            this.processQueue();
            return;
        }
        this.pendingSessions.add(session);
        session.currentStreamCount = 0;
        session.reservedStreamCount = 0;
        session.emptySessionCounted = false;
        session.gracefullyClosing = false;
        let settled = false;
        let sessionSetupTimeout;
        let socketTimeoutApplied = false;
        const sessionSocket = session.socket;
        const removeSessionSocketListener = sessionSocket.removeListener.bind(sessionSocket);
        const clearSocketTimeout = () => {
            removeSessionSocketListener('connect', applySocketTimeout);
            if (!socketTimeoutApplied) {
                return;
            }
            socketTimeoutApplied = false;
            session.off('timeout', onSocketTimeout);
            if (!session.closed && !session.destroyed) {
                session.setTimeout(this.timeout);
            }
        };
        const clearSessionSetup = () => {
            clearTimeout(sessionSetupTimeout);
            clearSocketTimeout();
            this.pendingSessions.delete(session);
            this.pendingSessionKeys.delete(key);
            delete entry.options._cancelSessionSetup;
        };
        const rejectSessionSetup = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearSessionSetup();
            entry.reject(error);
            queueMicrotask(() => {
                session.destroy(error);
            });
        };
        const onSocketTimeout = () => {
            rejectSessionSetup(new timed_out_TimeoutError(_socketTimeout, 'socket'));
        };
        const applySocketTimeout = () => {
            // A delay Node.js cannot arm means no socket timeout.
            if (!isArmableTimerDelay(_socketTimeout)) {
                return;
            }
            socketTimeoutApplied = true;
            session.setTimeout(_socketTimeout, onSocketTimeout);
        };
        if (this.timeout > 0) {
            session.setTimeout(this.timeout, () => {
                session.destroy();
            });
        }
        if (_socketTimeout !== undefined) {
            onceConnected(sessionSocket, applySocketTimeout);
        }
        if (setupTimeout !== undefined) {
            sessionSetupTimeout = setTimeout(() => {
                rejectSessionSetup(new timed_out_TimeoutError(setupTimeout, timeoutPhase ?? 'request'));
            }, setupTimeout);
            sessionSetupTimeout.unref();
        }
        const removeSession = () => {
            if (session.emptySessionCounted) {
                this.emptySessionCount--;
                session.emptySessionCounted = false;
            }
            const sessions = this.sessions.get(key);
            if (sessions) {
                const index = sessions.indexOf(session);
                if (index !== -1) {
                    sessions.splice(index, 1);
                }
                if (sessions.length === 0) {
                    this.sessions.delete(key);
                }
            }
        };
        session.once('remoteSettings', () => {
            if (settled) {
                return;
            }
            settled = true;
            clearSessionSetup();
            if (shouldPoolSession) {
                const sessions = this.sessions.get(key) ?? [];
                sessions.push(session);
                this.sessions.set(key, sessions);
            }
            this.emit('session', session);
            if (entry.reserveStream) {
                this.reserveStream(session);
            }
            entry.resolve({
                session,
                reusedSocket: false,
            });
        });
        // Updated stream limits can make room for queued requests without an active stream closing.
        session.on('remoteSettings', () => {
            this.processQueue();
        });
        session.once('error', error => {
            clearSessionSetup();
            if (!settled) {
                settled = true;
                entry.reject(error);
            }
            removeSession();
        });
        session.once('goaway', () => {
            session.gracefullyClosing = true;
            if (session.currentStreamCount === 0) {
                session.close();
            }
        });
        session.once('close', () => {
            clearSessionSetup();
            this.sessionCount--;
            if (!settled) {
                settled = true;
                entry.reject(new Error('The HTTP/2 session closed before settings were received'));
            }
            removeSession();
            this.processQueue();
        });
        entry.options._cancelSessionSetup = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearSessionSetup();
            entry.reject(new Error('HTTP/2 session setup canceled'));
            session.destroy();
        };
        const request = session.request.bind(session);
        session.request = (headers, streamOptions) => {
            const hasReservedStream = (session.reservedStreamCount ?? 0) > 0;
            if (hasReservedStream) {
                session.reservedStreamCount = session.reservedStreamCount - 1;
            }
            if (session.gracefullyClosing) {
                if (hasReservedStream) {
                    this.releaseStream(session, shouldPoolSession);
                }
                throw new Error('The session is gracefully closing. No new streams are allowed.');
            }
            if (!hasReservedStream) {
                this.reserveStream(session, false);
            }
            let stream;
            try {
                stream = request(headers, streamOptions);
            }
            catch (error) {
                this.releaseStream(session, shouldPoolSession);
                throw error;
            }
            stream.once('close', () => {
                this.releaseStream(session, shouldPoolSession);
            });
            return stream;
        };
    }
}
class Http2ClientRequest extends external_node_stream_.Writable {
    constructor(input, options, callback) {
        super({
            autoDestroy: false,
            emitClose: false,
        });
        const normalized = normalizeInput(input, options, callback);
        this.options = normalized.options;
        this.callback = normalized.callback;
        this.method = (this.options.method ?? 'GET').toUpperCase();
        this.path = this.method === HTTP2_METHOD_CONNECT ? this.options.path ?? '' : this.options.path ?? '/';
        this.protocol = this.options.protocol ?? 'https:';
        this.headers = Object.create(null);
        if (this.protocol !== 'https:' && !this.options.h2session) {
            throw new Error(`Protocol "${this.protocol}" not supported. Expected "https:"`);
        }
        const headers = this.options.headers;
        if (headers) {
            for (const [key, value] of Object.entries(headers)) {
                this.setHeader(key, value);
            }
        }
        if (this.options.auth && !this.hasHeader('authorization')) {
            this.setHeader('authorization', `Basic ${external_node_buffer_.Buffer.from(this.options.auth).toString('base64')}`);
        }
        if (this.callback) {
            this.once('response', this.callback);
        }
        const authority = getAuthority(this.options);
        this.origin = authority;
        if (!this.hasHeader(HTTP2_HEADER_AUTHORITY)) {
            this.headers[HTTP2_HEADER_AUTHORITY] = this.method === HTTP2_METHOD_CONNECT ? this.path : authority.host;
        }
        this.headers[HTTP2_HEADER_METHOD] = this.method;
        if (this.method !== HTTP2_METHOD_CONNECT) {
            this.headers[HTTP2_HEADER_SCHEME] = this.protocol.slice(0, -1);
            this.headers[HTTP2_HEADER_PATH] = this.path;
        }
    }
    agent;
    aborted = false;
    reusedSocket = false;
    res;
    socket;
    connection;
    method;
    path;
    protocol;
    host;
    headersSent = false;
    maxHeadersCount;
    options;
    callback;
    headers;
    origin;
    stream;
    pendingJobs = [];
    pendingAgentPromise;
    connectionHeaderNames = new Set();
    trailers;
    get isGotHttp2Request() {
        return true;
    }
    _write(chunk, encoding, callback) {
        this.runWithStream({
            run: () => {
                this.stream.write(chunk, encoding, callback);
            },
            cancel: callback,
        });
        void this.flushHeaders();
    }
    _final(callback) {
        this.runWithStream({
            run: () => {
                if (this.trailers) {
                    this.stream.once('wantTrailers', () => {
                        this.stream.sendTrailers(this.trailers);
                    });
                }
                this.stream.end(callback);
            },
            cancel: callback,
        });
        void this.flushHeaders();
    }
    _destroy(error, callback) {
        if (this.res && typeof this.res._dump === 'function') {
            this.res._dump();
        }
        void this.pendingAgentPromise?.catch(() => { });
        if (this.stream) {
            this.stream.close(NGHTTP2_CANCEL);
        }
        else {
            this.options._cancelSessionSetup?.();
            this.cancelPendingJobs(error ?? new Error('The HTTP/2 request was destroyed before a stream was created'));
        }
        callback(error);
        if (!this.stream) {
            // Node.js emits the `error` event on the next tick after the destroy callback, so `close` must be queued after it to keep the `http.ClientRequest` event order.
            external_node_process_.nextTick(() => {
                this.emit('close');
            });
        }
    }
    abort() {
        if (this.res?.complete) {
            return;
        }
        if (!this.aborted) {
            queueMicrotask(() => {
                this.emit('abort');
            });
        }
        this.aborted = true;
        this.destroy();
    }
    async flushHeaders() {
        if (this.headersSent || this.destroyed) {
            return;
        }
        this.headersSent = true;
        const streamOptions = {
            endStream: false,
            waitForTrailers: this.trailers !== undefined,
        };
        try {
            if (this.options.h2session) {
                this.reusedSocket = true;
                this.onStream(this.options.h2session.request(this.headers, streamOptions));
                return;
            }
            this.agent = this.options.agent === false ? new Http2Agent({ maxEmptySessions: 0 }) : this.options.agent ?? globalAgent;
            const streamPromise = this.agent.request(this.origin, this.options, this.headers, streamOptions);
            this.pendingAgentPromise = streamPromise;
            const { stream, reusedSocket } = await streamPromise;
            this.reusedSocket = reusedSocket;
            this.onStream(stream);
            this.pendingAgentPromise = undefined;
        }
        catch (error) {
            this.pendingAgentPromise = undefined;
            this.destroy(error);
        }
    }
    addTrailers(headers) {
        if (this.headersSent) {
            throw new Error('Cannot add trailers after the HTTP/2 stream has been created');
        }
        const trailers = Object.create(null);
        const connectionHeaderNames = new Set();
        for (const [name, value] of Object.entries(headers)) {
            (0,external_node_http_.validateHeaderName)(name);
            (0,external_node_http_.validateHeaderValue)(name, value);
            const lowercasedName = name.toLowerCase();
            if (isConnectionHeader(lowercasedName)) {
                for (const token of getConnectionHeaderTokens(value)) {
                    connectionHeaderNames.add(token);
                    Reflect.deleteProperty(trailers, token);
                }
                continue;
            }
            if (isDroppedHeader(lowercasedName, value, connectionHeaderNames)) {
                continue;
            }
            trailers[lowercasedName] = value;
        }
        this.trailers = trailers;
    }
    setHeader(name, value) {
        if (this.headersSent) {
            throw new Error('Cannot set headers after they are sent to the client');
        }
        (0,external_node_http_.validateHeaderName)(name);
        (0,external_node_http_.validateHeaderValue)(name, value);
        const lowercasedName = name.toLowerCase();
        if (isConnectionHeader(lowercasedName)) {
            for (const token of getConnectionHeaderTokens(value)) {
                this.connectionHeaderNames.add(token);
                Reflect.deleteProperty(this.headers, normalizeRequestHeaderName(token));
            }
            return this;
        }
        if (isDroppedHeader(lowercasedName, value, this.connectionHeaderNames)) {
            return this;
        }
        // Node's HTTP/2 API requires the canonical spelling of this case-insensitive token.
        this.headers[normalizeRequestHeaderName(name)] = lowercasedName === 'te' ? 'trailers' : value;
        return this;
    }
    setHeaders(headers) {
        if (this.headersSent) {
            throw new Error('Cannot set headers after they are sent to the client');
        }
        if (!(headers instanceof Headers) && !(headers instanceof Map)) {
            throw new TypeError('Headers must be a Headers instance or a Map');
        }
        for (const [name, value] of headers) {
            // Fetch Headers can contain multiple Set-Cookie fields, including commas within individual values.
            const headerValue = headers instanceof Headers && name === 'set-cookie' ? headers.getSetCookie() : value;
            this.setHeader(name, typeof headerValue === 'string' || typeof headerValue === 'number' ? headerValue : [...headerValue]);
        }
        return this;
    }
    appendHeader(name, value) {
        const current = this.getHeader(name);
        if (current === undefined) {
            return this.setHeader(name, typeof value === 'string' ? value : [...value]);
        }
        const values = Array.isArray(current) ? current : [String(current)];
        return this.setHeader(name, [...values, ...(typeof value === 'string' ? [value] : value)]);
    }
    getHeader(name) {
        return this.headers[normalizeRequestHeaderName(name)];
    }
    getHeaders() {
        // HTTP/2 pseudo-headers are not header fields, so they stay out of the public view.
        return Object.fromEntries(Object.entries(this.headers).filter(([name]) => !isPseudoHeader(name)));
    }
    getHeaderNames() {
        return Object.keys(this.getHeaders());
    }
    hasHeader(name) {
        return this.getHeader(name) !== undefined;
    }
    removeHeader(name) {
        if (this.headersSent) {
            throw new Error('Cannot remove headers after they are sent to the client');
        }
        // A removed `connection` header must stop nominating the headers it listed.
        if (isConnectionHeader(name.toLowerCase())) {
            for (const token of this.connectionHeaderNames) {
                Reflect.deleteProperty(this.headers, normalizeRequestHeaderName(token));
            }
            this.connectionHeaderNames.clear();
        }
        Reflect.deleteProperty(this.headers, normalizeRequestHeaderName(name));
    }
    setNoDelay() { }
    setSocketKeepAlive() { }
    setTimeout(ms, callback) {
        if (callback) {
            this.once('timeout', callback);
        }
        this.runWithStream({
            run: () => {
                this.stream.setTimeout(ms);
            },
        });
        return this;
    }
    // Runs the job now when the stream exists, or once `onStream` receives it.
    runWithStream(job) {
        if (this.stream) {
            job.run();
        }
        else {
            this.pendingJobs.push(job);
        }
    }
    cancelPendingJobs(error) {
        const jobs = this.pendingJobs;
        this.pendingJobs = [];
        for (const job of jobs) {
            job.cancel?.(error);
        }
    }
    onStream(stream) {
        this.stream = stream;
        this.socket = createSocketProxy(stream);
        this.connection = this.socket;
        if (this.destroyed) {
            stream.destroy();
            return;
        }
        let streamErrorSeen = false;
        stream.once('error', error => {
            streamErrorSeen = true;
            if (this.destroyed) {
                return;
            }
            this.destroy(error);
        });
        stream.on('timeout', () => {
            this.emit('timeout');
            this.res?.emit('timeout');
        });
        stream.once('aborted', () => {
            // A NO_ERROR reset can come with or without END_STREAM, so only preserve responses that already completed, or whose completeness can be verified from their semantics or Content-Length.
            if (this.res && stream.rstCode === NGHTTP2_NO_ERROR && this.res.isCompleteAfterNoErrorReset) {
                return;
            }
            if (this.res) {
                this.res.complete = false;
                this.res.aborted = true;
                this.res.emit('aborted');
                this.res.destroy();
            }
            else {
                this.destroy(new Error('The server aborted the HTTP/2 stream'));
            }
        });
        stream.once('response', (headers, _flags, rawHeaders) => {
            const response = new Http2IncomingMessage(stream, this, stream.readableHighWaterMark);
            const incomingResponse = response;
            response.statusCode = Number(headers[HTTP2_HEADER_STATUS]);
            response.headers = filterHeaders(headers);
            response.rawHeaders = rawHeaders ? filterRawHeaders(rawHeaders) : toRawHeaders(headers);
            response.headersDistinct = toDistinctHeaders(response.rawHeaders);
            response.url = `${this.origin.origin}${this.path}`;
            incomingResponse.req = this;
            this.res = incomingResponse;
            stream.on('data', chunk => {
                response.receivedSize += chunk.length;
                if (!response.push(chunk)) {
                    stream.pause();
                }
            });
            stream.once('end', () => {
                // A reset also ends the stream. An EOF that comes with an error code, including the
                // `CANCEL` of a request teardown, cut the body short, and an aborted response stays
                // aborted.
                if (!response.aborted && (stream.rstCode ?? NGHTTP2_NO_ERROR) === NGHTTP2_NO_ERROR) {
                    response.complete = true;
                    response.push(null);
                }
            });
            if (!this.emit('response', incomingResponse)) {
                response._dump();
            }
        });
        stream.on('headers', (headers, _flags, rawHeaders) => {
            this.emit('information', {
                statusCode: Number(headers[HTTP2_HEADER_STATUS]),
                statusMessage: '',
                httpVersion: '2.0',
                httpVersionMajor: 2,
                httpVersionMinor: 0,
                headers: filterHeaders(headers),
                rawHeaders: rawHeaders ? filterRawHeaders(rawHeaders) : toRawHeaders(headers),
            });
        });
        stream.on('continue', () => {
            this.emit('continue');
        });
        stream.once('trailers', (trailers, _flags, rawTrailers) => {
            if (!this.res) {
                return;
            }
            this.res.trailers = trailers;
            this.res.rawTrailers = Array.isArray(rawTrailers) ? rawTrailers : toRawHeaders(trailers);
            this.res.trailersDistinct = toDistinctHeaders(this.res.rawTrailers);
        });
        stream.once('close', () => {
            if (this.res) {
                if (this.aborted || (!this.res.aborted && !streamErrorSeen && !this.res.complete && !this.res.readableEnded)) {
                    // `abort()` and a self-initiated `destroy()` cancel the stream without an
                    // `aborted` event, so complete the response the way a premature close would.
                    // A peer reset already completed it through the stream's `aborted` event, and
                    // a stream error propagates through the request error.
                    this.res.aborted = true;
                    this.res.emit('aborted');
                    this.res.destroy();
                }
                const finish = () => {
                    this.res.emit('close');
                    this.destroy();
                    this.emit('close');
                };
                if (this.res.readable) {
                    this.res.once('end', finish);
                }
                else {
                    finish();
                }
                return;
            }
            if (!this.destroyed) {
                this.destroy(new Error('The HTTP/2 stream has been early terminated'));
                queueMicrotask(() => {
                    this.emit('close');
                });
                return;
            }
            this.destroy();
            this.emit('close');
        });
        for (const job of this.pendingJobs) {
            job.run();
        }
        this.pendingJobs = [];
        this.emit('socket', this.socket);
    }
}
const globalAgent = new Http2Agent();
const request = (input, options, callback) => new Http2ClientRequest(input, options, callback);
const getSourceOptions = (input, options) => {
    if (typeof input === 'object' && !(input instanceof URL)) {
        return input;
    }
    return typeof options === 'object' ? options : {};
};
const requestHttps = (options, callback) => {
    options.ALPNProtocols = ['http/1.1'];
    delete options.timeout;
    delete options._socketTimeout;
    delete options._timeoutPhase;
    return external_node_https_.request(options, callback);
};
const requestHttp1 = (options, agent, callback) => {
    if (typeof agent === 'object' && 'https' in agent) {
        options.agent = agent.https;
    }
    if (options.headers) {
        const headers = { ...options.headers };
        Reflect.deleteProperty(headers, HTTP2_HEADER_METHOD);
        Reflect.deleteProperty(headers, HTTP2_HEADER_SCHEME);
        Reflect.deleteProperty(headers, HTTP2_HEADER_PATH);
        // The test is on the value rather than on the presence of the key, so an `Object.hasOwn`
        // rewrite would forward an empty `:authority` as a host.
        // eslint-disable-next-line unicorn/no-computed-property-existence-check
        if (headers[HTTP2_HEADER_AUTHORITY] && !headers.host) {
            headers.host = headers[HTTP2_HEADER_AUTHORITY];
        }
        Reflect.deleteProperty(headers, HTTP2_HEADER_AUTHORITY);
        options.headers = headers;
    }
    return requestHttps(options, callback);
};
const requestHttp2 = (options, agent, socket, callback) => {
    options.agent = typeof agent === 'object' && 'http2' in agent ? agent.http2 : agent;
    if (socket) {
        options._reuseSocket = socket;
        options._reuseSocketShouldPool = options.createConnection === undefined;
    }
    return request(options, callback);
};
const auto = async (input, options, callback) => {
    const sourceOptions = getSourceOptions(input, options);
    const normalized = normalizeInput(input, options, callback);
    options = normalized.options;
    callback = normalized.callback;
    options.ALPNProtocols ??= ['h2', 'http/1.1'];
    options.protocol ??= 'https:';
    if (options.h2session) {
        return request(options, callback);
    }
    if (options.protocol !== 'https:') {
        options.agent = options.agent?.http;
        return external_node_http_.request(options, callback);
    }
    const agent = options.agent;
    if (hasCustomHttpsAgent(agent) && options.createConnection === undefined) {
        options.agent = agent.https;
        return requestHttps(options, callback);
    }
    const { alpnProtocol, socket } = await resolveProtocol(options, sourceOptions);
    if (alpnProtocol === 'h2') {
        return requestHttp2(options, agent, socket, callback);
    }
    socket?.destroy();
    return requestHttp1(options, agent, callback);
};
const http2Client = {
    Agent: Http2Agent,
    auto,
    globalAgent,
    request,
};
/* harmony default export */ const http2_client = (http2Client);

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/options.js


// DO NOT use destructuring for `https.request` and `http.request` as it's not compatible with `nock`.











const isAgentObject = (agent) => distribution.object(agent) && ('http' in agent || 'https' in agent || 'http2' in agent);
const getNativeAgent = (url, agent) => {
    if (!isAgentObject(agent)) {
        return agent;
    }
    return url.protocol === 'https:' ? agent.https : agent.http;
};
/**
Generic helper that wraps any assertion function to add context to error messages.
*/
function wrapAssertionWithContext(optionName, assertionFn) {
    try {
        assertionFn();
    }
    catch (error) {
        if (error instanceof Error) {
            error.message = `Option '${optionName}': ${error.message}`;
        }
        throw error;
    }
}
/**
Helper function that wraps assert.any() to provide better error messages.
When assertion fails, it includes the option name in the error message.
*/
function options_assertAny(optionName, validators, value) {
    wrapAssertionWithContext(optionName, () => {
        assert.any(validators, value);
    });
}
// A count. `Infinity` stays a valid "never" value.
function assertCount(optionName, value) {
    if (value === Infinity) {
        return;
    }
    options_assertAny(optionName, [distribution.nonNegativeInteger], value);
}
/**
Helper function that wraps assert.plainObject() to provide better error messages.
When assertion fails, it includes the option name in the error message.
*/
function options_assertPlainObject(optionName, value) {
    wrapAssertionWithContext(optionName, () => {
        assert.plainObject(value);
    });
}
function isSameOrigin(previousUrl, nextUrl) {
    return previousUrl.origin === nextUrl.origin
        && getUnixSocketPath(previousUrl) === getUnixSocketPath(nextUrl);
}
const crossOriginStripHeaders = ['host', 'cookie', 'cookie2', 'authorization', 'proxy-authorization'];
const bodyHeaderNames = ['content-length', 'content-encoding', 'content-language', 'content-location', 'content-type', 'transfer-encoding', 'digest', 'content-digest', 'repr-digest', 'last-modified'];
function usesUnixSocket(url) {
    return url.protocol === 'unix:' || getUnixSocketPath(url) !== undefined;
}
function hasCredentialInUrl(url, credential) {
    if (url instanceof URL) {
        return url[credential] !== '';
    }
    if (!distribution.string(url)) {
        return false;
    }
    try {
        return new URL(url)[credential] !== '';
    }
    catch {
        return false;
    }
}
const hasExplicitCredentialInUrlChange = (changedState, url, credential) => (changedState.has(credential)
    || ((changedState.has('url') || changedState.has('prefixUrl')) && url?.[credential] !== ''));
const hasBodyOptionChanged = (changedState) => changedState.has('body') || changedState.has('json') || changedState.has('form');
// The URL parser leaves malformed percent-escapes untouched, so decoding must not throw.
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
const hasProtocolSlashes = (value) => /^[a-z][\d+\-.a-z]*:\/\//iv.test(value);
const hasHttpProtocolWithoutSlashes = (value) => /^https?:(?!\/\/)/iv.test(value);
const hasUnixProtocolWithoutSlashes = (value) => /^unix:/iv.test(value);
const isAbsoluteUrl = (url) => distribution.urlInstance(url) || (distribution.string(url) && (hasProtocolSlashes(url) || url.startsWith('//')));
const isSlashOrBackslash = (character) => character === '/' || character === '\\';
const startsWithSchemeRelativeSeparators = (value) => value.length > 1 && isSlashOrBackslash(value[0]) && isSlashOrBackslash(value[1]);
const stripLeadingC0ControlOrSpace = (value) => {
    let index = 0;
    while (index < value.length && value.codePointAt(index) <= 0x20) {
        index++;
    }
    return value.slice(index);
};
const removeAsciiTabOrNewline = (value) => {
    let result = '';
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== 0x09 && codePoint !== 0x0A && codePoint !== 0x0D) {
            result += character;
        }
    }
    return result;
};
const assertRelativeUrlIfNeeded = (options, url) => {
    if (!options.prefixUrl || options.allowAbsoluteUrls) {
        return;
    }
    const normalizedUrl = distribution.string(url) ? stripLeadingC0ControlOrSpace(removeAsciiTabOrNewline(url)) : url;
    const isDisallowed = isAbsoluteUrl(normalizedUrl)
        || (distribution.string(normalizedUrl) && (hasHttpProtocolWithoutSlashes(normalizedUrl)
            || startsWithSchemeRelativeSeparators(normalizedUrl)
            || (options.enableUnixSockets && hasUnixProtocolWithoutSlashes(normalizedUrl))));
    if (isDisallowed) {
        throw new Error('The `url` option must be relative when `allowAbsoluteUrls` is false and `prefixUrl` is set');
    }
};
const assertUrlHasSameOriginAsPrefixUrlIfNeeded = (options, url) => {
    if (!options.prefixUrl || options.allowAbsoluteUrls) {
        return;
    }
    let prefixUrl;
    try {
        prefixUrl = new URL(options.prefixUrl);
    }
    catch {
        return;
    }
    if (isSameOrigin(prefixUrl, url)) {
        return;
    }
    throw new Error('The `url` option must stay on the same origin as `prefixUrl` when `allowAbsoluteUrls` is false');
};
const getUrlPrefixBoundary = (options) => ({
    url: options.url instanceof URL ? new URL(options.url) : undefined,
    prefixUrl: options.prefixUrl.toString(),
    allowAbsoluteUrls: options.allowAbsoluteUrls,
});
const hasUrlOrPrefixUrlBoundaryChanged = (options, currentUrl, previous) => (currentUrl.href !== previous.url?.href
    || options.prefixUrl.toString() !== previous.prefixUrl
    || options.allowAbsoluteUrls !== previous.allowAbsoluteUrls);
function applyUrlOverride(options, url, { username, password, baseUrl } = {}) {
    assertRelativeUrlIfNeeded(options, url);
    if (distribution.string(url) && options.url) {
        const resolvedUrl = new URL(url, baseUrl ?? options.url);
        url = resolvedUrl.href;
    }
    if (options.allowAbsoluteUrls) {
        options.prefixUrl = '';
        options.url = url;
    }
    else {
        const { allowAbsoluteUrls } = options;
        try {
            options.allowAbsoluteUrls = true;
            options.url = url;
        }
        finally {
            options.allowAbsoluteUrls = allowAbsoluteUrls;
        }
    }
    if (username !== undefined) {
        options.username = username;
    }
    if (password !== undefined) {
        options.password = password;
    }
    return options.url;
}
function assertValidHeaderName(name) {
    if (name.startsWith(':')) {
        throw new TypeError(`HTTP/2 pseudo-headers are not supported in \`options.headers\`: ${name}`);
    }
    // Assigning it would re-prototype the live headers object instead of adding a header.
    if (name === '__proto__') {
        throw new TypeError('The `__proto__` header name is not supported in `options.headers`');
    }
}
/**
Safely assign own properties from source to target, skipping `__proto__` to prevent prototype pollution from JSON.parse'd input.
*/
function safeObjectAssign(target, source) {
    for (const [key, value] of Object.entries(source)) {
        if (key === '__proto__') {
            continue;
        }
        Reflect.set(target, key, value);
    }
}
// `__proto__` is skipped like in `safeObjectAssign`, which never assigns it.
function assertKnownKeys(value, knownOptions, createError) {
    for (const key of Object.keys(value)) {
        if (key === '__proto__') {
            continue;
        }
        if (!Object.hasOwn(knownOptions, key)) {
            throw createError(key);
        }
    }
}
const isToughCookieJar = (cookieJar) => cookieJar.setCookie.length === 4 && cookieJar.getCookieString.length === 0;
function validateSearchParameters(searchParameters) {
    for (const [key, value] of Object.entries(searchParameters)) {
        if (key === '__proto__') {
            continue;
        }
        options_assertAny(`searchParams.${key}`, [distribution.string, distribution.number, distribution.boolean, distribution.null, distribution.undefined], value);
    }
}
const globalCache = new Map();
const dnsCacheLookups = new WeakMap();
const adaptedDnsLookups = new WeakMap();
let globalDnsCache;
const getGlobalDnsCache = () => {
    globalDnsCache ??= new DnsCache();
    return globalDnsCache;
};
// Node asks a lookup for every address when it selects a family itself, so a lookup written
// against the documented single-result shape has to be adapted.
const getAdaptedLookup = (lookup) => {
    let adapted = adaptedDnsLookups.get(lookup);
    if (!adapted) {
        adapted = (hostname, options, callback) => {
            lookup(hostname, options, (error, address, family) => {
                if (error) {
                    callback(error, address, family);
                    return;
                }
                callback(null, options.all && !Array.isArray(address) ? [{ address, family: family }] : address, family);
            });
        };
        adaptedDnsLookups.set(lookup, adapted);
    }
    return adapted;
};
const getDnsCacheLookup = (cache) => {
    let lookup = dnsCacheLookups.get(cache);
    if (!lookup) {
        // Preserve the cache receiver and stable lookup identity for HTTP/2 session reuse.
        lookup = (hostname, options, callback) => {
            cache.lookup(hostname, options, callback);
        };
        dnsCacheLookups.set(cache, lookup);
    }
    return lookup;
};
// Detects and wraps QuickLRU v7+ instances to make them compatible with the StorageAdapter interface
const wrapQuickLruIfNeeded = (value) => {
    // Check if this is QuickLRU v7+ using Symbol.toStringTag and the evict method (added in v7)
    if (value?.[Symbol.toStringTag] === 'QuickLRU' && typeof value.evict === 'function') {
        // QuickLRU v7+ uses set(key, value, {maxAge: number}) but StorageAdapter expects set(key, value, ttl)
        // Wrap it to translate the interface
        return {
            get(key) {
                return value.get(key);
            },
            set(key, cacheValue, ttl) {
                if (ttl === undefined) {
                    value.set(key, cacheValue);
                }
                else {
                    value.set(key, cacheValue, { maxAge: ttl });
                }
                return true;
            },
            delete(key) {
                return value.delete(key);
            },
            clear() {
                return value.clear();
            },
            has(key) {
                return value.has(key);
            },
        };
    }
    // QuickLRU v5 and other caches work as-is
    return value;
};
const defaultInternals = {
    request: undefined,
    agent: {
        http: undefined,
        https: undefined,
        http2: undefined,
    },
    h2session: undefined,
    decompress: true,
    timeout: {
        connect: undefined,
        lookup: undefined,
        read: undefined,
        request: undefined,
        response: undefined,
        secureConnect: undefined,
        send: undefined,
        socket: undefined,
    },
    prefixUrl: '',
    body: undefined,
    form: undefined,
    json: undefined,
    cookieJar: undefined,
    ignoreInvalidCookies: false,
    searchParams: undefined,
    dnsLookup: undefined,
    dnsCache: undefined,
    context: {},
    hooks: {
        init: [],
        beforeRequest: [],
        beforeError: [],
        beforeRedirect: [],
        beforeRetry: [],
        beforeCache: [],
        afterResponse: [],
    },
    followRedirect: true,
    maxRedirects: 10,
    cache: undefined,
    throwHttpErrors: true,
    username: '',
    password: '',
    http2: false,
    allowGetBody: false,
    allowAbsoluteUrls: true,
    copyPipedHeaders: false,
    headers: {
        'user-agent': 'got (https://github.com/sindresorhus/got)',
    },
    methodRewriting: false,
    dnsLookupIpVersion: undefined,
    parseJson: JSON.parse,
    stringifyJson: JSON.stringify,
    retry: {
        limit: 2,
        methods: [
            'GET',
            'PUT',
            'HEAD',
            'DELETE',
            'OPTIONS',
            'TRACE',
            'QUERY',
        ],
        statusCodes: [
            408,
            413,
            429,
            500,
            502,
            503,
            504,
            521,
            522,
            524,
        ],
        errorCodes: [
            'ETIMEDOUT',
            'ECONNRESET',
            'EADDRINUSE',
            'ECONNREFUSED',
            'EPIPE',
            'ENOTFOUND',
            'ENETUNREACH',
            'EAI_AGAIN',
        ],
        maxRetryAfter: undefined,
        calculateDelay: ({ computedValue }) => computedValue,
        backoffLimit: Infinity,
        noise: 100,
        enforceRetryRules: true,
    },
    localAddress: undefined,
    method: 'GET',
    createConnection: undefined,
    cacheOptions: {
        shared: undefined,
        cacheHeuristic: undefined,
        immutableMinTimeToLive: undefined,
        ignoreCargoCult: undefined,
    },
    https: {
        alpnProtocols: undefined,
        rejectUnauthorized: undefined,
        checkServerIdentity: undefined,
        serverName: undefined,
        certificateAuthority: undefined,
        key: undefined,
        certificate: undefined,
        passphrase: undefined,
        pfx: undefined,
        ciphers: undefined,
        honorCipherOrder: undefined,
        minVersion: undefined,
        maxVersion: undefined,
        signatureAlgorithms: undefined,
        tlsSessionLifetime: undefined,
        dhparam: undefined,
        ecdhCurve: undefined,
        certificateRevocationLists: undefined,
        secureOptions: undefined,
    },
    encoding: undefined,
    resolveBodyOnly: false,
    isStream: false,
    responseType: 'text',
    url: undefined,
    pagination: {
        transform(response) {
            if (response.request.options.responseType === 'json') {
                return response.body;
            }
            const body = response.request.options.responseType === 'buffer'
                ? decodeUint8Array(response.body, response.request.options.encoding)
                : response.body;
            return response.request.options.parseJson(body);
        },
        paginate({ response }) {
            const rawLinkHeader = response.headers.link;
            if (typeof rawLinkHeader !== 'string' || rawLinkHeader.trim() === '') {
                return false;
            }
            const parsed = parseLinkHeader(rawLinkHeader);
            // The `rel` parameter is a space-separated list of relation types compared case-insensitively. See https://www.rfc-editor.org/rfc/rfc8288#section-3.3
            // Ignore links with an anchor instead of changing their context (RFC 8288, section 3.2).
            const next = parsed.find(entry => !Object.hasOwn(entry.parameters, 'anchor') && entry.parameters.rel?.replaceAll('"', '').toLowerCase().split(/\s+/v).includes('next'));
            if (next) {
                return {
                    url: next.reference,
                };
            }
            return false;
        },
        filter: () => true,
        shouldContinue: () => true,
        countLimit: Infinity,
        backoff: 0,
        requestLimit: 10_000,
        stackAllItems: false,
    },
    setHost: true,
    maxHeaderSize: undefined,
    signal: undefined,
    enableUnixSockets: false,
    strictContentLength: true,
};
const cloneHeaderValue = (value) => {
    if (Array.isArray(value)) {
        return [...value];
    }
    return typeof value === 'number' ? String(value) : value;
};
// `__proto__` is skipped so a `JSON.parse`d headers object cannot become a request header.
const cloneHeaders = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => name !== '__proto__').map(([name, value]) => [name, cloneHeaderValue(value)]));
// TLS option lists and key/PFX descriptors must not be shared between requests.
const cloneHttps = (https) => Object.fromEntries(Object.entries(https).map(([key, value]) => [key, Array.isArray(value) ? value.map(item => distribution.plainObject(item) ? { ...item } : item) : value]));
const cloneInternals = (internals) => {
    const { hooks, retry } = internals;
    const result = {
        ...internals,
        url: internals.url ? new URL(internals.url) : undefined,
        context: { ...internals.context },
        cacheOptions: { ...internals.cacheOptions },
        https: cloneHttps(internals.https),
        agent: { ...internals.agent },
        headers: cloneHeaders(internals.headers),
        retry: {
            ...retry,
            errorCodes: [...retry.errorCodes],
            methods: [...retry.methods],
            statusCodes: [...retry.statusCodes],
        },
        timeout: { ...internals.timeout },
        hooks: Object.fromEntries(Object.entries(hooks).map(([event, handlers]) => [event, [...handlers]])),
        searchParams: internals.searchParams ? new URLSearchParams(internals.searchParams) : undefined,
        pagination: { ...internals.pagination },
    };
    return result;
};
const cloneRaw = (raw) => {
    const result = { ...raw };
    // The result is a copy that is meant to be filled in, so assigning onto it is the point.
    // eslint-disable-next-line unicorn/no-immediate-mutation
    if (Object.hasOwn(raw, 'https') && distribution.object(raw.https)) {
        result.https = cloneHttps(raw.https);
    }
    for (const key of ['context', 'cacheOptions', 'agent', 'timeout', 'pagination']) {
        if (Object.hasOwn(raw, key) && distribution.object(raw[key])) {
            result[key] = { ...raw[key] };
        }
    }
    if (Object.hasOwn(raw, 'headers') && distribution.object(raw.headers)) {
        result.headers = cloneHeaders(raw.headers);
    }
    if (Object.hasOwn(raw, 'retry') && distribution.object(raw.retry)) {
        const { retry } = raw;
        result.retry = { ...retry };
        if (distribution.array(retry.errorCodes)) {
            result.retry.errorCodes = [...retry.errorCodes];
        }
        if (distribution.array(retry.methods)) {
            result.retry.methods = [...retry.methods];
        }
        if (distribution.array(retry.statusCodes)) {
            result.retry.statusCodes = [...retry.statusCodes];
        }
    }
    if (Object.hasOwn(raw, 'hooks') && distribution.object(raw.hooks)) {
        const { hooks } = raw;
        result.hooks = {
            ...hooks,
        };
        for (const event of Object.keys(defaultInternals.hooks)) {
            const handlers = hooks[event];
            if (distribution.array(handlers)) {
                // @ts-expect-error Indexing by a widened `keyof Hooks` loses the correlation to `handlers`'s specific array type.
                result.hooks[event] = [...handlers];
            }
        }
    }
    if (Object.hasOwn(raw, 'searchParams') && raw.searchParams) {
        if (distribution.string(raw.searchParams)) {
            result.searchParams = raw.searchParams;
        }
        else if (raw.searchParams instanceof URLSearchParams) {
            result.searchParams = new URLSearchParams(raw.searchParams);
        }
        else {
            // A `URL`, `Map` or `Set` is an object without enumerable own keys, so it has to be
            // rejected before the spread turns it into an empty object.
            options_assertPlainObject('searchParams', raw.searchParams);
            result.searchParams = { ...raw.searchParams };
        }
    }
    return result;
};
// The HTTP/2 client uses one timer for these phases, so the smallest value decides both when
// it fires and which phase the resulting error reports. Delays Node.js cannot arm mean no
// constraint and are excluded instead of winning the minimum.
const getHttp2Timeout = (internals) => {
    const delays = [
        ['lookup', internals.timeout.lookup],
        ['connect', internals.timeout.connect],
        ['secureConnect', internals.timeout.secureConnect],
        ['request', internals.timeout.request],
    ].filter((entry) => typeof entry[1] === 'number' && isArmableTimerDelay(entry[1]));
    if (delays.length === 0) {
        return undefined;
    }
    let lowest = delays[0];
    for (const entry of delays) {
        if (entry[1] < lowest[1]) {
            lowest = entry;
        }
    }
    return { timeout: lowest[1], phase: lowest[0] };
};
const usesHttp2Alpn = (internals, url) => {
    const usesCustomHttpsAgent = internals.agent.https !== undefined
        && internals.agent.https !== false
        && internals.createConnection === undefined;
    return internals.http2
        && url.protocol === 'https:'
        && !internals.h2session
        && !usesCustomHttpsAgent;
};
const trackReplacedHeaderMutations = (trackedStateMutations, previousHeaders, nextHeaders) => {
    if (!trackedStateMutations) {
        return;
    }
    for (const header of new Set([...Object.keys(previousHeaders), ...Object.keys(nextHeaders)])) {
        if (previousHeaders[header] !== nextHeaders[header]) {
            trackedStateMutations.add(header);
        }
    }
};
const init = (options, withOptions, self) => {
    const initHooks = options.hooks?.init;
    if (initHooks) {
        for (const hook of initHooks) {
            hook(withOptions, self);
        }
    }
};
// Keys never merged: got.extend() internals, url (passed as first arg), control flags, security
const nonMergeableKeys = new Set(['mutableDefaults', 'handlers', 'url', 'preserveHooks', 'isStream', '__proto__']);
// Options where an explicit `undefined` resets the inherited value instead of keeping it.
const resettableByUndefined = new Set(['searchParams', 'cookieJar']);
// Whether the options supply a body, JSON, or form payload explicitly.
const hasExplicitBodyOption = (options) => (Object.hasOwn(options, 'body') && options.body !== undefined)
    || (Object.hasOwn(options, 'json') && options.json !== undefined)
    || (Object.hasOwn(options, 'form') && options.form !== undefined);
class Options {
    #internals;
    #headersProxy;
    #merging = false;
    #init;
    #explicitHeaders;
    #trackedStateMutations;
    constructor(input, options, defaults) {
        options_assertAny('input', [distribution.string, distribution.urlInstance, distribution.object, distribution.undefined], input);
        options_assertAny('options', [distribution.object, distribution.undefined], options);
        options_assertAny('defaults', [distribution.object, distribution.undefined], defaults);
        if (input instanceof Options || options instanceof Options) {
            throw new TypeError('The defaults must be passed as the third argument');
        }
        if (defaults) {
            this.#internals = cloneInternals(defaults.#internals);
            this.#init = [...defaults.#init];
            this.#explicitHeaders = new Set(defaults.#explicitHeaders);
        }
        else {
            this.#internals = cloneInternals(defaultInternals);
            this.#init = [];
            this.#explicitHeaders = new Set();
        }
        this.#headersProxy = this.#createHeadersProxy();
        // This rule allows `finally` to be considered more important.
        // Meaning no matter the error thrown in the `try` block,
        // if `finally` throws then the `finally` error will be thrown.
        //
        // Yes, we want this. If we set `url` first, then the `url.searchParams`
        // would get merged. Instead we set the `searchParams` first, then
        // `url.searchParams` is overwritten as expected.
        //
        /* eslint-disable no-unsafe-finally -- `finally` is used intentionally here to ensure `url` is always set last, overwriting any merged searchParams */
        try {
            if (distribution.plainObject(input)) {
                // The plain object carries the url, so one in the second argument would be
                // silently ignored, the same conflict the string input reports.
                if (options?.url !== undefined) {
                    throw new TypeError('The `url` option is mutually exclusive with the `input` argument');
                }
                try {
                    this.merge(input);
                    this.merge(options);
                }
                finally {
                    this.url = input.url;
                }
            }
            else {
                try {
                    this.merge(options);
                }
                finally {
                    if (options?.url !== undefined) {
                        if (input === undefined) {
                            this.url = options.url;
                        }
                        else {
                            throw new TypeError('The `url` option is mutually exclusive with the `input` argument');
                        }
                    }
                    else if (input !== undefined) {
                        this.url = input;
                    }
                }
            }
        }
        catch (error) {
            const optionsError = normalizeError(error);
            optionsError.options = this;
            throw optionsError;
        }
        /* eslint-enable no-unsafe-finally */
    }
    merge(options) {
        if (!options) {
            return;
        }
        if (options instanceof Options) {
            // Create a copy of the #init array to avoid infinite loop
            // when merging an Options instance with itself
            const initArray = [...options.#init];
            for (const init of initArray) {
                this.merge(init);
            }
            return;
        }
        options = cloneRaw(options);
        init(this, options, this);
        init(options, options, this);
        this.#merging = true;
        try {
            let push = false;
            for (const key of Object.keys(options)) {
                if (nonMergeableKeys.has(key)) {
                    continue;
                }
                if (!optionNames.has(key)) {
                    throw new Error(`Unexpected option: ${key}`);
                }
                // @ts-expect-error Type 'unknown' is not assignable to type 'never'.
                const value = options[key];
                if (value === undefined && !resettableByUndefined.has(key)) {
                    continue;
                }
                // @ts-expect-error Type 'unknown' is not assignable to type 'never'.
                this[key] = value;
                push = true;
            }
            if (push) {
                this.#init.push(options);
            }
        }
        finally {
            this.#merging = false;
        }
    }
    /**
    Custom request function.

    @default Got's built-in HTTP/1.1 or HTTP/2 request implementation
    */
    get request() {
        return this.#internals.request;
    }
    set request(value) {
        options_assertAny('request', [distribution.function, distribution.undefined], value);
        this.#internals.request = value;
    }
    /**
    An object representing `http`, `https` and `http2` keys for [`http.Agent`](https://nodejs.org/api/http.html#http_class_http_agent), [`https.Agent`](https://nodejs.org/api/https.html#https_class_https_agent), and Got's internal HTTP/2 session pool.
    This is necessary because a request to one protocol might redirect to another.
    In such a scenario, Got will switch over to the right protocol agent for you.
    When `http2` is enabled, a custom `agent.https` instance makes Got use the native HTTP/1.1 request path because Got's built-in HTTP/2 session pool does not support custom HTTPS agents.

    If a key is not present, it will default to a global agent.

    @example
    ```
    import got from 'got';
    import HttpAgent from 'agentkeepalive';

    const {HttpsAgent} = HttpAgent;

    await got('https://sindresorhus.com', {
        agent: {
            http: new HttpAgent(),
            https: new HttpsAgent()
        }
    });
    ```
    */
    get agent() {
        return this.#internals.agent;
    }
    set agent(value) {
        options_assertPlainObject('agent', value);
        for (const key of Object.keys(value)) {
            if (key === '__proto__') {
                continue;
            }
            if (!Object.hasOwn(defaultInternals.agent, key)) {
                throw new TypeError(`Unexpected agent option: ${key}`);
            }
            const validators = key === 'http2'
                ? [distribution.undefined, (v) => v === false]
                : [distribution.object, distribution.undefined, (v) => v === false];
            options_assertAny(`agent.${key}`, validators, value[key]);
        }
        this.#mergeOrReplace('agent', value);
    }
    get h2session() {
        return this.#internals.h2session;
    }
    set h2session(value) {
        options_assertAny('h2session', [distribution.object, distribution.undefined], value);
        this.#internals.h2session = value;
    }
    /**
    Decompress the response automatically.

    This will set the `accept-encoding` header to `gzip, deflate, br` unless you set it yourself.

    If this is disabled, a compressed response is returned as a `Uint8Array`.
    This may be useful if you want to handle decompression yourself or stream the raw compressed data.

    @default true
    */
    get decompress() {
        return this.#internals.decompress;
    }
    set decompress(value) {
        assert.boolean(value);
        this.#internals.decompress = value;
    }
    /**
    Milliseconds to wait for the server to end the response before aborting the request with `got.TimeoutError` error (a.k.a. `request` property).
    By default, there's no timeout.

    This also accepts an `object` with the following fields to constrain the duration of each phase of the request lifecycle:

    - `lookup` starts when a socket is assigned and ends when the hostname has been resolved.
        Does not apply when using a Unix domain socket.
    - `connect` starts when `lookup` completes (or when the socket is assigned if lookup does not apply to the request) and ends when the socket is connected.
    - `secureConnect` starts when `connect` completes and ends when the handshaking process completes (HTTPS only).
    - `socket` starts when the socket is connected. See [request.setTimeout](https://nodejs.org/api/http.html#http_request_settimeout_timeout_callback).
    - `response` starts when the request has been written to the socket and ends when the response headers are received.
    - `send` starts when the socket is connected and ends with the request has been written to the socket.
    - `request` starts when the request is initiated and ends when the response's end event fires.
    */
    get timeout() {
        // We always return `Delays` here.
        // It has to be `Delays | number`, otherwise TypeScript will error because the getter and the setter have incompatible types.
        return this.#internals.timeout;
    }
    set timeout(value) {
        options_assertPlainObject('timeout', value);
        for (const key of Object.keys(value)) {
            if (key === '__proto__') {
                continue;
            }
            if (!Object.hasOwn(defaultInternals.timeout, key)) {
                throw new Error(`Unexpected timeout option: ${key}`);
            }
            options_assertAny(`timeout.${key}`, [distribution.number, distribution.undefined], value[key]);
        }
        this.#mergeOrReplace('timeout', value);
    }
    /**
    When specified, `prefixUrl` will be prepended to relative string `url` input.
    The prefix must be an absolute URL, since Got has no base to resolve it against. It must not contain a query string or a fragment.
    A trailing slash `/` is optional - one will be added automatically.

    __Note__: Absolute string URLs and URL instances bypass `prefixUrl` by default. Other instance defaults, including headers, still apply. For untrusted URLs, set `allowAbsoluteUrls` to `false`.

    __Note__: Got cannot know which custom headers are sensitive. If you use headers like `x-api-key`, only pass trusted URLs or use `allowAbsoluteUrls: false`.

    __Note__: Leading slashes in `input` are disallowed when using this option to enforce consistency and avoid confusion.
    For example, when the prefix URL is `https://example.com/foo` and the input is `/bar`, there's ambiguity whether the resulting URL would become `https://example.com/foo/bar` or `https://example.com/bar`.
    The latter is used by browsers.

    __Tip__: Useful when used with `got.extend()` to create niche-specific Got instances.

    __Tip__: You can change `prefixUrl` using hooks as long as the URL still includes the `prefixUrl`.
    If the URL doesn't include it anymore, it will throw.

    @example
    ```
    import got from 'got';

    await got('unicorn', {prefixUrl: 'https://cats.com'});
    //=> 'https://cats.com/unicorn'

    const instance = got.extend({
        prefixUrl: 'https://google.com'
    });

    await instance('unicorn', {
        hooks: {
            beforeRequest: [
                options => {
                    options.prefixUrl = 'https://cats.com';
                }
            ]
        }
    });
    //=> 'https://cats.com/unicorn'
    ```
    */
    get prefixUrl() {
        // We always return `string` here.
        // It has to be `string | URL`, otherwise TypeScript will error because the getter and the setter have incompatible types.
        return this.#internals.prefixUrl;
    }
    set prefixUrl(value) {
        options_assertAny('prefixUrl', [distribution.string, distribution.urlInstance], value);
        if (value === '') {
            this.#internals.prefixUrl = '';
            return;
        }
        value = value.toString();
        if (hasProtocolSlashes(value)) {
            // The prefix is concatenated with the path, so a query or a fragment would swallow it.
            // A scheme-relative prefix has no base to parse against and fails at request time.
            const prefix = new URL(value);
            if (prefix.search !== '' || prefix.hash !== '') {
                throw new TypeError('The `prefixUrl` option must not contain a query string or a fragment');
            }
        }
        if (!value.endsWith('/')) {
            value += '/';
        }
        if (this.#internals.prefixUrl && this.#internals.url) {
            const url = this.#internals.url;
            const previousUrl = new URL(url);
            const { username, password } = url;
            const urlWithoutCredentials = new URL(url);
            urlWithoutCredentials.username = '';
            urlWithoutCredentials.password = '';
            let prefixUrlWithoutCredentials = this.#internals.prefixUrl.toString();
            let hasNewPrefixCredentials = false;
            if (isAbsoluteUrl(value)) {
                const nextPrefixUrl = new URL(value);
                hasNewPrefixCredentials = nextPrefixUrl.username !== '' || nextPrefixUrl.password !== '';
            }
            if (isAbsoluteUrl(this.#internals.prefixUrl)) {
                const prefixUrl = new URL(this.#internals.prefixUrl);
                prefixUrl.username = '';
                prefixUrl.password = '';
                prefixUrlWithoutCredentials = prefixUrl.href;
            }
            if (!urlWithoutCredentials.href.startsWith(prefixUrlWithoutCredentials)) {
                throw new Error('The `url` option must include the `prefixUrl` option');
            }
            url.href = value + urlWithoutCredentials.href.slice(prefixUrlWithoutCredentials.length);
            const isSameOriginUrl = isSameOrigin(previousUrl, url);
            if (username && !url.username && isSameOriginUrl && !hasNewPrefixCredentials) {
                url.username = username;
            }
            if (password && !url.password && isSameOriginUrl && !hasNewPrefixCredentials) {
                url.password = password;
            }
        }
        this.#internals.prefixUrl = value;
        this.#trackedStateMutations?.add('prefixUrl');
    }
    /**
    __Note #1__: The `body` option cannot be used with the `json` or `form` option.

    __Note #2__: If you provide this option, `got.stream()` will be read-only.

    __Note #3__: If you provide a payload with the `GET` or `HEAD` method, it will throw a `TypeError` unless the method is `GET` and the `allowGetBody` option is set to `true`.

    __Note #4__: This option is not enumerable and will not be merged with the instance defaults.

    The `content-length` header will be automatically set if `body` is a `string` or an `ArrayBufferView` (including `Uint8Array`, other typed arrays, and `DataView`), and `content-length` and `transfer-encoding` are not manually set in `options.headers`.

    Since Got 12, the `content-length` is not automatically set when `body` is a `fs.createReadStream`.

    You can use `Iterable` and `AsyncIterable` objects as request body, including Web [`ReadableStream`](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream):

    @example
    ```
    import got from 'got';

    // Using an async generator
    async function* generateData() {
        yield 'Hello, ';
        yield 'world!';
    }

    await got.post('https://httpbin.org/anything', {
        body: generateData()
    });
    ```
    */
    get body() {
        return this.#internals.body;
    }
    set body(value) {
        options_assertAny('body', [distribution.string, distribution.buffer, distribution.nodeStream, distribution.generator, distribution.asyncGenerator, distribution.iterable, distribution.asyncIterable, ArrayBuffer.isView, distribution.undefined], value);
        if (distribution.nodeStream(value)) {
            assert.truthy(value.readable);
        }
        if (value !== undefined) {
            assert.undefined(this.#internals.form);
            assert.undefined(this.#internals.json);
        }
        this.#internals.body = value;
        this.#trackedStateMutations?.add('body');
    }
    /**
    The form body is converted to a query string using [`(new URLSearchParams(object)).toString()`](https://nodejs.org/api/url.html#url_constructor_new_urlsearchparams_obj).

    If the `Content-Type` header is not present, it will be set to `application/x-www-form-urlencoded`.

    __Note #1__: If you provide this option, `got.stream()` will be read-only.

    __Note #2__: This option is not enumerable and will not be merged with the instance defaults.
    */
    get form() {
        return this.#internals.form;
    }
    set form(value) {
        options_assertAny('form', [distribution.plainObject, distribution.undefined], value);
        if (value !== undefined) {
            assert.undefined(this.#internals.body);
            assert.undefined(this.#internals.json);
        }
        this.#internals.form = value;
        this.#trackedStateMutations?.add('form');
    }
    /**
    JSON request body. If the `content-type` header is not set, it will be set to `application/json`.

    __Important__: This option only affects the request body you send to the server. To parse the response as JSON, you must either call `.json()` on the promise or set `responseType: 'json'` in the options.

    __Note #1__: If you provide this option, `got.stream()` will be read-only.

    __Note #2__: This option is not enumerable and will not be merged with the instance defaults.
    */
    get json() {
        return this.#internals.json;
    }
    set json(value) {
        if (value !== undefined) {
            assert.undefined(this.#internals.body);
            assert.undefined(this.#internals.form);
        }
        this.#internals.json = value;
        this.#trackedStateMutations?.add('json');
    }
    /**
    The URL to request, as a string or a [WHATWG `URL`](https://nodejs.org/api/url.html#url_class_url).

    Pass it as the first argument to `got(url, options)`. Setting `url` inside an options object is not supported.

    Properties from `options` will override properties in the parsed `url`.

    If no protocol is specified, it will throw a `TypeError`.

    __Note__: The query string is **not** parsed as search params.

    @example
    ```
    await got('https://example.com/?query=a b'); //=> https://example.com/?query=a%20b
    await got('https://example.com/', {searchParams: {query: 'a b'}}); //=> https://example.com/?query=a+b

    // The query string is overridden by `searchParams`
    await got('https://example.com/?query=a b', {searchParams: {query: 'a b'}}); //=> https://example.com/?query=a+b
    ```
    */
    get url() {
        return this.#internals.url;
    }
    set url(value) {
        options_assertAny('url', [distribution.string, distribution.urlInstance, distribution.undefined], value);
        if (value === undefined) {
            this.#internals.url = undefined;
            this.#trackedStateMutations?.add('url');
            return;
        }
        if (distribution.string(value) && value.startsWith('/')) {
            throw new Error('`url` must not start with a slash');
        }
        const valueString = value.toString();
        if (distribution.string(value)
            && !this.prefixUrl
            // The URL parser strips leading C0 control characters and spaces, so the guard has
            // to see the normalized string or whitespace would smuggle a protocol past it.
            && hasHttpProtocolWithoutSlashes(stripLeadingC0ControlOrSpace(removeAsciiTabOrNewline(value)))) {
            throw new Error('`url` protocol must be followed by `//`');
        }
        // Detect if URL is already absolute.
        const isAbsolute = isAbsoluteUrl(value);
        assertRelativeUrlIfNeeded(this, value);
        // Only concatenate prefixUrl if the URL is relative
        const urlString = isAbsolute ? valueString : `${this.prefixUrl}${valueString}`;
        const url = new URL(urlString);
        // Validate before storing, so a rejected url never stays on the instance.
        if (usesUnixSocket(url) && !this.#internals.enableUnixSockets) {
            throw new Error('Using UNIX domain sockets but option `enableUnixSockets` is not enabled');
        }
        if (url.protocol === 'unix:') {
            url.href = `http://unix${url.pathname}${url.search}`;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            const error = new Error(`Unsupported protocol: ${url.protocol}`);
            error.code = 'ERR_UNSUPPORTED_PROTOCOL';
            throw error;
        }
        this.#internals.url = url;
        this.#trackedStateMutations?.add('url');
        if (this.#internals.username) {
            url.username = this.#internals.username;
            this.#internals.username = '';
        }
        if (this.#internals.password) {
            url.password = this.#internals.password;
            this.#internals.password = '';
        }
        if (this.#internals.searchParams) {
            url.search = this.#internals.searchParams.toString();
            this.#internals.searchParams = undefined;
        }
    }
    /**
    Cookie support. You don't have to care about parsing or how to store them.

    __Note__: If you provide this option, `options.headers.cookie` will be overridden.
    */
    get cookieJar() {
        return this.#internals.cookieJar;
    }
    set cookieJar(value) {
        options_assertAny('cookieJar', [distribution.object, distribution.undefined], value);
        if (value === undefined) {
            this.#internals.cookieJar = undefined;
            return;
        }
        const { setCookie, getCookieString } = value;
        assert.function(setCookie);
        assert.function(getCookieString);
        /* istanbul ignore next: Horrible `tough-cookie` v3 check */
        if (isToughCookieJar(value)) {
            this.#internals.cookieJar = {
                setCookie: (0,external_node_util_.promisify)(value.setCookie.bind(value)),
                getCookieString: (0,external_node_util_.promisify)(value.getCookieString.bind(value)),
            };
        }
        else {
            this.#internals.cookieJar = value;
        }
    }
    /**
    You can abort the `request` using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

    @example
    ```
    import got from 'got';

    const abortController = new AbortController();

    const request = got('https://httpbin.org/anything', {
        signal: abortController.signal
    });

    setTimeout(() => {
        abortController.abort();
    }, 100);
    ```
    */
    get signal() {
        return this.#internals.signal;
    }
    set signal(value) {
        options_assertAny('signal', [distribution.object, distribution.undefined], value);
        this.#internals.signal = value;
    }
    /**
    Ignore invalid cookies instead of throwing an error.
    Only useful when the `cookieJar` option has been set. Not recommended.

    @default false
    */
    get ignoreInvalidCookies() {
        return this.#internals.ignoreInvalidCookies;
    }
    set ignoreInvalidCookies(value) {
        assert.boolean(value);
        this.#internals.ignoreInvalidCookies = value;
    }
    /**
    Query string that will be added to the request URL.
    This will override the query string in `url`.

    If you need to pass in an array, you can do it using a `URLSearchParams` instance.

    @example
    ```
    import got from 'got';

    const searchParams = new URLSearchParams([['key', 'a'], ['key', 'b']]);

    await got('https://example.com', {searchParams});

    console.log(searchParams.toString());
    //=> 'key=a&key=b'
    ```
    */
    get searchParams() {
        if (Object.isFrozen(this.#internals)) {
            // A frozen instance is read-only, so a copy is handed out. Writing to it is
            // discarded instead of reaching the live parameters or the url they belong to.
            const { url } = this.#internals;
            return new URLSearchParams(url ? url.searchParams : this.#internals.searchParams);
        }
        if (this.#internals.url) {
            return this.#internals.url.searchParams;
        }
        this.#internals.searchParams ??= new URLSearchParams();
        return this.#internals.searchParams;
    }
    set searchParams(value) {
        options_assertAny('searchParams', [distribution.string, distribution.object, distribution.undefined], value);
        // A frozen instance is read-only, and the url it holds is part of that state. Without
        // this the assignment below would rewrite the query string of a frozen url instead of
        // failing like every other frozen option does.
        if (Object.isFrozen(this.#internals)) {
            throw new TypeError('Cannot assign to read only option `searchParams`');
        }
        const url = this.#internals.url;
        if (value === undefined) {
            this.#internals.searchParams = undefined;
            if (url) {
                url.search = '';
            }
            return;
        }
        const searchParameters = this.searchParams;
        let updated;
        if (distribution.string(value) || value instanceof URLSearchParams) {
            // A `URLSearchParams` is cloned so the caller-owned object is not stored by reference.
            updated = new URLSearchParams(value);
        }
        else {
            // A `URL`, `Map` or `Set` is an object without enumerable own keys, which would
            // silently erase the query string instead of being reported.
            options_assertPlainObject('searchParams', value);
            validateSearchParameters(value);
            updated = new URLSearchParams();
            for (const [key, entry] of Object.entries(value)) {
                if (key === '__proto__') {
                    continue;
                }
                if (entry === null) {
                    updated.append(key, '');
                }
                else if (entry === undefined) {
                    searchParameters.delete(key);
                }
                else {
                    updated.append(key, entry);
                }
            }
        }
        if (this.#merging) {
            // These keys will be replaced
            for (const key of updated.keys()) {
                searchParameters.delete(key);
            }
            for (const [key, value] of updated) {
                searchParameters.append(key, value);
            }
        }
        else if (url) {
            // Overrides the query string in the URL.
            url.search = updated.toString();
        }
        else {
            this.#internals.searchParams = updated;
        }
    }
    get dnsLookup() {
        return this.#internals.dnsLookup;
    }
    set dnsLookup(value) {
        options_assertAny('dnsLookup', [distribution.function, distribution.undefined], value);
        this.#internals.dnsLookup = value;
    }
    /**
    A DNS cache instance used for making DNS lookups.
    Useful when making lots of requests to different *public* hostnames.
    Set to `true` to use Got's shared DNS cache.
    When using `got.extend()`, set to `false` to opt out of a DNS cache configured by the parent instance.

    Got's built-in DNS cache uses `dns.resolve4(…)` and `dns.resolve6(…)` under the hood and falls back to `dns.lookup(…)` when no DNS records are found, which may lead to additional delay.
    Because it resolves A and AAAA records separately, it cannot preserve OS-specific `verbatim` address ordering from `dns.lookup(…)`.
    If present, `clear(hostname?)` can be called by user code to clear cached entries.

    __Note__: This should stay disabled when making requests to internal hostnames such as `localhost`, `database.local` etc.

    @default undefined
    */
    get dnsCache() {
        return this.#internals.dnsCache;
    }
    set dnsCache(value) {
        options_assertAny('dnsCache', [distribution.object, distribution.boolean, distribution.undefined], value);
        if (value === true) {
            this.#internals.dnsCache = getGlobalDnsCache();
        }
        else if (value === false) {
            this.#internals.dnsCache = undefined;
        }
        else {
            if (value !== undefined) {
                options_assertAny('dnsCache.lookup', [distribution.function], value.lookup);
                options_assertAny('dnsCache.clear', [distribution.function, distribution.undefined], value.clear);
            }
            this.#internals.dnsCache = value;
        }
    }
    /**
    User data. `context` is shallow merged and enumerable. If it contains non-enumerable properties they will NOT be merged.

    @example
    ```
    import got from 'got';

    const instance = got.extend({
        hooks: {
            beforeRequest: [
                options => {
                    if (!options.context || !options.context.token) {
                        throw new Error('Token required');
                    }

                    options.headers.token = options.context.token;
                }
            ]
        }
    });

    const context = {
        token: 'secret'
    };

    const response = await instance('https://httpbin.org/headers', {context});

    // Let's see the headers
    console.log(response.body);
    ```
    */
    get context() {
        return this.#internals.context;
    }
    set context(value) {
        assert.object(value);
        this.#mergeOrReplace('context', value);
    }
    /**
    Hooks allow modifications during the request lifecycle.
    Hook functions may be async and are run serially.
    */
    get hooks() {
        return this.#internals.hooks;
    }
    set hooks(value) {
        assert.object(value);
        for (const knownHookEvent of Object.keys(value)) {
            if (knownHookEvent === '__proto__') {
                continue;
            }
            if (!Object.hasOwn(this.#internals.hooks, knownHookEvent)) {
                throw new Error(`Unexpected hook event: ${knownHookEvent}`);
            }
            const typedKnownHookEvent = knownHookEvent;
            const hooks = value[typedKnownHookEvent];
            options_assertAny(`hooks.${knownHookEvent}`, [distribution.array, distribution.undefined], hooks);
            // An `undefined` value is ignored, matching every other option.
            if (!hooks) {
                continue;
            }
            for (const hook of hooks) {
                assert.function(hook);
            }
            if (this.#merging) {
                // @ts-expect-error Indexing by a widened `keyof Hooks` loses the correlation to `hooks`'s specific array type.
                this.#internals.hooks[typedKnownHookEvent].push(...hooks);
            }
            else {
                // @ts-expect-error Indexing by a widened `keyof Hooks` loses the correlation to `hooks`'s specific array type.
                this.#internals.hooks[knownHookEvent] = [...hooks];
            }
        }
    }
    /**
    Whether redirect responses should be followed automatically.

    Optionally, pass a function to dynamically decide based on the response object. The function is only called for 3xx responses, and an unchanged function is evaluated only once per response.

    Note that if a `303` is sent by the server in response to any request type (`POST`, `DELETE`, etc.), Got will automatically request the resource pointed to in the location header via `GET`.
    This is in accordance with [the spec](https://tools.ietf.org/html/rfc7231#section-6.4.4). You can optionally turn on this behavior also for other redirect codes - see `methodRewriting`.
    On cross-origin redirects, Got strips `host`, `cookie`, `cookie2`, `authorization`, and `proxy-authorization`. When a redirect rewrites the request to `GET`, Got also strips request body headers. Use `hooks.beforeRedirect` for app-specific sensitive headers.

    @default true
    */
    get followRedirect() {
        return this.#internals.followRedirect;
    }
    set followRedirect(value) {
        options_assertAny('followRedirect', [distribution.boolean, distribution.function], value);
        this.#internals.followRedirect = value;
    }
    /**
    If exceeded, the request will be aborted and a `MaxRedirectsError` will be thrown.

    @default 10
    */
    get maxRedirects() {
        return this.#internals.maxRedirects;
    }
    set maxRedirects(value) {
        assertCount('maxRedirects', value);
        this.#internals.maxRedirects = value;
    }
    /**
    A cache adapter instance for storing cached response data.

    @default undefined
    */
    get cache() {
        return this.#internals.cache;
    }
    set cache(value) {
        options_assertAny('cache', [distribution.object, distribution.string, distribution.boolean, distribution.undefined], value);
        if (value === true) {
            this.#internals.cache = globalCache;
        }
        else if (value === false) {
            this.#internals.cache = undefined;
        }
        else {
            this.#internals.cache = wrapQuickLruIfNeeded(value);
        }
    }
    /**
    Determines if a `got.HTTPError` is thrown for unsuccessful responses.

    If this is disabled, requests that encounter an error status code will be resolved with the `response` instead of throwing.
    This may be useful if you are checking for resource availability and are expecting error responses.

    @default true
    */
    get throwHttpErrors() {
        return this.#internals.throwHttpErrors;
    }
    set throwHttpErrors(value) {
        assert.boolean(value);
        this.#internals.throwHttpErrors = value;
    }
    get username() {
        return this.#getCredential('username');
    }
    set username(value) {
        assert.string(value);
        this.#setCredential('username', value);
    }
    get password() {
        return this.#getCredential('password');
    }
    set password(value) {
        assert.string(value);
        this.#setCredential('password', value);
    }
    /**
    If set to `true`, Got will additionally accept HTTP/2 requests.

    It will choose either HTTP/1.1 or HTTP/2 depending on the ALPN protocol. When a custom `agent.https` instance is set, Got uses that native HTTPS agent directly and skips HTTP/2 negotiation.

    __Note__: If `options.request` returns a request or response, it controls the transport and Got's HTTP/2 client is bypassed. Return `undefined` to fall back to Got's built-in transport.

    @default false

    @example
    ```
    import got from 'got';

    const {headers} = await got('https://nghttp2.org/httpbin/anything', {http2: true});

    console.log(headers.via);
    //=> '2 nghttpx'
    ```
    */
    get http2() {
        return this.#internals.http2;
    }
    set http2(value) {
        assert.boolean(value);
        this.#internals.http2 = value;
    }
    /**
    Set this to `true` to allow sending body for the `GET` method.
    This option is only meant to interact with non-compliant servers when you have no other choice.

    __Note__: The [RFC 7231](https://tools.ietf.org/html/rfc7231#section-4.3.1) doesn't specify any particular behavior for the GET method having a payload, therefore __it's considered an [anti-pattern](https://en.wikipedia.org/wiki/Anti-pattern)__.

    @default false
    */
    get allowGetBody() {
        return this.#internals.allowGetBody;
    }
    set allowGetBody(value) {
        assert.boolean(value);
        this.#internals.allowGetBody = value;
    }
    /**
    Allow absolute URLs to bypass `prefixUrl`.

    When set to `false` with `prefixUrl`, passing an absolute `url` will throw. This also rejects scheme-relative URL strings like `//example.com/path` in retry and pagination URL overrides. Use this when untrusted URL input must stay on the same origin as the configured `prefixUrl`. This is not a path sandbox: relative paths like `../other` still follow standard URL resolution on the same origin. Set `prefixUrl` to an empty string for a request that intentionally needs an absolute URL.

    __Note__: This guards the `url` you pass. It does not block cross-origin redirects issued by the server, though inherited sensitive headers are still stripped when a redirect changes origin.

    __Note__: The check is defeated if the same hook or `pagination.paginate(…)` return also sets `prefixUrl` or `allowAbsoluteUrls`. Do not populate those options from untrusted data.

    @default true
    */
    get allowAbsoluteUrls() {
        return this.#internals.allowAbsoluteUrls;
    }
    set allowAbsoluteUrls(value) {
        assert.boolean(value);
        this.#internals.allowAbsoluteUrls = value;
    }
    /**
    Automatically copy headers from piped streams.

    When piping a request into a Got stream (e.g., `request.pipe(got.stream(url))`), this controls whether headers from the source stream are automatically merged into the Got request headers.

    Note: Explicitly set headers take precedence over piped headers. Piped headers are only copied when a header is not already explicitly set.

    Useful for proxy scenarios when explicitly enabled. Got automatically omits `host`, `authorization`, `cookie`, `cookie2`, `set-cookie`, `set-cookie2`, hop-by-hop headers, and headers nominated by `Connection`/`Proxy-Connection`. Got cannot know which app-specific headers are sensitive. Leave `copyPipedHeaders` disabled and copy only safe headers manually, or explicitly omit those headers before piping. If you trust the upstream and want to forward credentials, pass them explicitly in `headers`.

    @default false

    @example
    ```
    import got from 'got';
    import {pipeline} from 'node:stream/promises';

    // Opt in to automatic header copying for proxy scenarios
    server.get('/proxy', async (request, response) => {
        const gotStream = got.stream('https://example.com', {
            copyPipedHeaders: true,
            // Explicit headers win over piped headers.
            // Add credentials here only when the upstream is trusted.
            headers: {
                host: 'example.com',
            }
        });

        await pipeline(request, gotStream, response);
    });
    ```

    @example
    ```
    import got from 'got';
    import {pipeline} from 'node:stream/promises';

    // Keep it disabled and manually copy only safe headers
    server.get('/proxy', async (request, response) => {
        const gotStream = got.stream('https://example.com', {
            headers: {
                'user-agent': request.headers['user-agent'],
                'accept': request.headers['accept'],
                // Explicitly NOT copying host, connection, authorization, etc.
            }
        });

        await pipeline(request, gotStream, response);
    });
    ```
    */
    get copyPipedHeaders() {
        return this.#internals.copyPipedHeaders;
    }
    set copyPipedHeaders(value) {
        assert.boolean(value);
        this.#internals.copyPipedHeaders = value;
    }
    isHeaderExplicitlySet(name) {
        return this.#explicitHeaders.has(name.toLowerCase());
    }
    shouldCopyPipedHeader(name) {
        return !this.isHeaderExplicitlySet(name);
    }
    setPipedHeader(name, value) {
        assertValidHeaderName(name);
        this.#internals.headers[name.toLowerCase()] = value;
    }
    getInternalHeaders() {
        return this.#internals.headers;
    }
    setInternalHeader(name, value) {
        if (value === undefined) {
            this.deleteInternalHeader(name);
            return;
        }
        assertValidHeaderName(name);
        this.#internals.headers[name.toLowerCase()] = value;
    }
    deleteInternalHeader(name) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete this.#internals.headers[name.toLowerCase()];
    }
    async trackStateMutations(operation) {
        const changedState = new Set();
        this.#trackedStateMutations = changedState;
        try {
            return await operation(changedState);
        }
        finally {
            this.#trackedStateMutations = undefined;
        }
    }
    clearBody() {
        this.body = undefined;
        this.json = undefined;
        this.form = undefined;
        for (const header of bodyHeaderNames) {
            this.deleteInternalHeader(header);
        }
    }
    clearUnchangedCookieHeader(previousState, changedState) {
        if (previousState?.hadCookieJar
            && this.cookieJar === undefined
            && !this.isHeaderExplicitlySet('cookie')
            && !changedState?.has('cookie')
            && this.headers.cookie === previousState.headers.cookie) {
            this.deleteInternalHeader('cookie');
        }
    }
    restoreCookieHeader(previousState, headers) {
        if (!previousState || Object.keys(headers ?? {}).some(name => name.toLowerCase() === 'cookie')) {
            return;
        }
        if (previousState.cookieWasExplicitlySet) {
            this.headers.cookie = previousState.headers.cookie;
            return;
        }
        delete this.headers.cookie;
        if (previousState.headers.cookie !== undefined) {
            this.setInternalHeader('cookie', previousState.headers.cookie);
        }
    }
    syncCookieHeaderAfterMerge(previousState, headers) {
        this.restoreCookieHeader(previousState, headers);
        this.clearUnchangedCookieHeader(previousState);
    }
    stripUnchangedCrossOriginState(previousState, changedState, { clearBody = true } = {}) {
        const headers = this.getInternalHeaders();
        const url = this.#internals.url;
        for (const header of crossOriginStripHeaders) {
            if (!changedState.has(header) && headers[header] === previousState.headers[header]) {
                this.deleteInternalHeader(header);
            }
        }
        for (const credential of ['username', 'password']) {
            if (!hasExplicitCredentialInUrlChange(changedState, url, credential)) {
                this[credential] = '';
            }
        }
        if (clearBody && !hasBodyOptionChanged(changedState) && isBodyUnchanged(this, previousState)) {
            this.clearBody();
        }
    }
    /**
    Strip sensitive headers and credentials when navigating to a different origin.
    Headers and credentials explicitly provided in `userOptions` are preserved.
    */
    stripSensitiveHeaders(previousUrl, nextUrl, userOptions) {
        if (isSameOrigin(previousUrl, nextUrl)) {
            return;
        }
        const headers = lowercase_keys_lowercaseKeys(userOptions.headers ?? {});
        for (const header of crossOriginStripHeaders) {
            if (headers[header] === undefined) {
                this.deleteInternalHeader(header);
            }
        }
        for (const credential of ['username', 'password']) {
            const hasExplicitCredential = (Object.hasOwn(userOptions, credential) && userOptions[credential] !== undefined)
                || hasCredentialInUrl(userOptions.url, credential)
                || hasCredentialInUrl(userOptions.prefixUrl, credential)
                || isCrossOriginCredentialChanged(previousUrl, nextUrl, credential);
            if (!hasExplicitCredential && this[credential] !== '') {
                this[credential] = '';
            }
        }
    }
    /**
    Merge the options for a follow-up request into `this` and apply the cross-origin rules. This is shared by `afterResponse` retries (when the hook passes a new options object) and by pagination.

    Returns the resolved `nextUrl` when `updatedOptions.url` was supplied, so callers can run their own checks on it, and whether the caller supplied an explicit body.
    */
    mergeNextRequestOptions(updatedOptions, { previousUrl, previousState, previousBoundary, baseUrl, }) {
        const hasExplicitBody = hasExplicitBodyOption(updatedOptions);
        const clearsCookieJar = Object.hasOwn(updatedOptions, 'cookieJar') && updatedOptions.cookieJar === undefined;
        if (hasExplicitBody) {
            const contentType = this.isHeaderExplicitlySet('content-type') ? this.headers['content-type'] : undefined;
            this.clearBody();
            this.setInternalHeader('content-type', contentType);
        }
        if (clearsCookieJar) {
            this.cookieJar = undefined;
        }
        const { url, ...updatedOptionsWithoutUrl } = updatedOptions;
        this.merge(updatedOptionsWithoutUrl);
        this.syncCookieHeaderAfterMerge(previousState, updatedOptionsWithoutUrl.headers);
        const currentUrl = this.url;
        if (previousUrl
            && currentUrl instanceof URL
            && hasUrlOrPrefixUrlBoundaryChanged(this, currentUrl, previousBoundary)) {
            assertUrlHasSameOriginAsPrefixUrlIfNeeded(this, currentUrl);
        }
        if (url === undefined
            && previousUrl
            && currentUrl instanceof URL
            && !isSameOrigin(previousUrl, currentUrl)) {
            this.stripSensitiveHeaders(previousUrl, currentUrl, updatedOptions);
            if (!hasExplicitBody) {
                this.clearBody();
            }
        }
        let nextUrl;
        if (url !== undefined) {
            nextUrl = applyUrlOverride(this, url, { ...updatedOptions, baseUrl });
            // Explicit search parameters override the query string in the new URL.
            if (updatedOptions.searchParams !== undefined) {
                this.searchParams = updatedOptions.searchParams;
            }
            if (previousUrl) {
                this.stripSensitiveHeaders(previousUrl, nextUrl, updatedOptions);
                if (!isSameOrigin(previousUrl, nextUrl) && !hasExplicitBody) {
                    this.clearBody();
                }
            }
        }
        return { nextUrl, hasExplicitBody };
    }
    /**
    Request headers.

    Existing headers will be overwritten. Headers set to `undefined` will be omitted. Number values are stored and sent as strings.

    @default {'user-agent': 'got (https://github.com/sindresorhus/got)'}
    */
    get headers() {
        return this.#headersProxy;
    }
    set headers(value) {
        options_assertPlainObject('headers', value);
        const normalizedHeaders = lowercase_keys_lowercaseKeys(cloneHeaders(value));
        for (const header of Object.keys(normalizedHeaders)) {
            assertValidHeaderName(header);
        }
        if (this.#merging) {
            safeObjectAssign(this.#internals.headers, normalizedHeaders);
        }
        else {
            const previousHeaders = this.#internals.headers;
            this.#internals.headers = normalizedHeaders;
            this.#headersProxy = this.#createHeadersProxy();
            this.#explicitHeaders.clear();
            trackReplacedHeaderMutations(this.#trackedStateMutations, previousHeaders, normalizedHeaders);
        }
        for (const header of Object.keys(normalizedHeaders)) {
            this.#explicitHeaders.add(header);
            if (this.#merging) {
                this.#trackedStateMutations?.add(header);
            }
        }
    }
    /**
    Specifies if the HTTP request method should be [rewritten as `GET`](https://tools.ietf.org/html/rfc7231#section-6.4) on redirects.

    As the [specification](https://tools.ietf.org/html/rfc7231#section-6.4) prefers to rewrite the HTTP method only on `303` responses, this is Got's default behavior. Cross-origin `301` and `302` redirects also rewrite `POST` requests to `GET` by default to avoid forwarding request bodies to another origin.
    Setting `methodRewriting` to `true` will also rewrite same-origin `301` and `302` responses, as allowed by the spec. This is the behavior followed by `curl` and browsers.

    __Note__: Got never performs method rewriting on `307` and `308` responses, as this is [explicitly prohibited by the specification](https://www.rfc-editor.org/rfc/rfc7231#section-6.4.7).

    @default false
    */
    get methodRewriting() {
        return this.#internals.methodRewriting;
    }
    set methodRewriting(value) {
        assert.boolean(value);
        this.#internals.methodRewriting = value;
    }
    /**
    Indicates which DNS record family to use.

    Values:
    - `undefined`: IPv4 (if present) or IPv6
    - `4`: Only IPv4
    - `6`: Only IPv6

    @default undefined
    */
    get dnsLookupIpVersion() {
        return this.#internals.dnsLookupIpVersion;
    }
    set dnsLookupIpVersion(value) {
        if (value !== undefined && value !== 4 && value !== 6) {
            throw new TypeError(`Invalid DNS lookup IP version: ${value}`);
        }
        this.#internals.dnsLookupIpVersion = value;
    }
    /**
    A function used to parse JSON responses.

    @example
    ```
    import got from 'got';
    import {parse} from '@hapi/bourne';

    // Preventing prototype pollution by using Bourne
    const parsed = await got('https://example.com', {
        parseJson: text => parse(text)
    }).json();

    console.log(parsed);
    ```
    */
    get parseJson() {
        return this.#internals.parseJson;
    }
    set parseJson(value) {
        assert.function(value);
        this.#internals.parseJson = value;
    }
    /**
    A function used to stringify the body of JSON requests.

    @example
    ```
    import got from 'got';

    await got.post('https://example.com', {
        stringifyJson: object => JSON.stringify(object, (key, value) => {
            if (key.startsWith('_')) {
                return;
            }

            return value;
        }),
        json: {
            some: 'payload',
            _ignoreMe: 1234
        }
    });
    ```

    @example
    ```
    import got from 'got';

    await got.post('https://example.com', {
        stringifyJson: object => JSON.stringify(object, (key, value) => {
            if (typeof value === 'number') {
                return value.toString();
            }

            return value;
        }),
        json: {
            some: 'payload',
            number: 1
        }
    });
    ```
    */
    get stringifyJson() {
        return this.#internals.stringifyJson;
    }
    set stringifyJson(value) {
        assert.function(value);
        this.#internals.stringifyJson = value;
    }
    /**
    An object representing `limit`, `calculateDelay`, `methods`, `statusCodes`, `maxRetryAfter` and `errorCodes` fields for maximum retry count, retry handler, allowed methods, allowed status codes, maximum [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) time and allowed error codes.

    Undefined settings preserve inherited values, except `maxRetryAfter`, where `undefined` restores the request timeout fallback.

    Delays between retries are calculated with `Math.max(1, Math.min((2 ** (attemptCount - 1)) * 1000, backoffLimit) + noise)`, where `attemptCount` starts at 1 and `noise` is the randomized retry noise. Setting both `backoffLimit` and `noise` to `0` requests an immediate retry; returning `0` from `calculateDelay` still aborts the retry.

    The `calculateDelay` property is a `function` that receives an object with `attemptCount`, `retryOptions`, `error` and `computedValue` properties for current retry count, the retry options, error and default computed value.
    The function must return a delay in milliseconds (or a Promise resolving with it) (`0` return value cancels retry).

    Delays above `2_147_483_647` milliseconds (Node.js's timer limit), including `Infinity`, abort the retry instead of triggering an immediate retry. This also applies to delays computed from `Retry-After`.

    The `enforceRetryRules` property is a `boolean` that, when set to `true` (default), enforces the `limit`, `methods`, `statusCodes`, and `errorCodes` options before calling `calculateDelay`. Your `calculateDelay` function is only invoked when a retry is allowed based on these criteria. When `false`, `calculateDelay` receives the computed value but can override all retry logic.

    __Note:__ When `enforceRetryRules` is `false`, you must check `computedValue` in your `calculateDelay` function to respect retry rules. When `true` (default), the retry rules are enforced automatically.

    By default, it retries *only* on the specified methods, status codes, and on these network errors:

    - `ETIMEDOUT`: One of the [timeout](#timeout) limits were reached.
    - `ECONNRESET`: Connection was forcibly closed by a peer.
    - `EADDRINUSE`: Could not bind to any free port.
    - `ECONNREFUSED`: Connection was refused by the server.
    - `EPIPE`: The remote side of the stream being written has been closed.
    - `ENOTFOUND`: Couldn't resolve the hostname to an IP address.
    - `ENETUNREACH`: No internet connection.
    - `EAI_AGAIN`: DNS lookup timed out.

    __Note__: If `maxRetryAfter` is set to `undefined`, it will use `options.timeout`.
    __Note__: If [`Retry-After`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) header is greater than `maxRetryAfter`, it will cancel the request.
    */
    get retry() {
        return this.#internals.retry;
    }
    set retry(value) {
        options_assertPlainObject('retry', value);
        options_assertAny('retry.calculateDelay', [distribution.function, distribution.undefined], value.calculateDelay);
        options_assertAny('retry.maxRetryAfter', [distribution.number, distribution.undefined], value.maxRetryAfter);
        // `undefined` restores the inherited limit, so only a defined value is a count.
        if (!distribution.undefined(value.limit)) {
            assertCount('retry.limit', value.limit);
        }
        options_assertAny('retry.methods', [distribution.array, distribution.undefined], value.methods);
        options_assertAny('retry.statusCodes', [distribution.array, distribution.undefined], value.statusCodes);
        options_assertAny('retry.errorCodes', [distribution.array, distribution.undefined], value.errorCodes);
        options_assertAny('retry.noise', [distribution.number, distribution.undefined], value.noise);
        options_assertAny('retry.backoffLimit', [distribution.number, distribution.undefined], value.backoffLimit);
        options_assertAny('retry.enforceRetryRules', [distribution.boolean, distribution.undefined], value.enforceRetryRules);
        // The members are compared against a method name and a numeric status code, so a
        // wrong type would silently disable the retry instead of being reported here.
        for (const [key, predicate] of [['methods', distribution.string], ['statusCodes', distribution.number], ['errorCodes', distribution.string]]) {
            for (const [index, member] of (value[key] ?? []).entries()) {
                options_assertAny(`retry.${key}[${index}]`, [predicate], member);
            }
        }
        if (value.noise && Math.abs(value.noise) > 100) {
            throw new Error(`The maximum acceptable retry noise is +/- 100ms, got ${value.noise}`);
        }
        assertKnownKeys(value, this.#internals.retry, key => new Error(`Unexpected retry option: ${key}`));
        // Keep the undefined reset for maxRetryAfter, which falls back to the request timeout.
        const updatedRetry = Object.fromEntries(Object.entries(value).filter(([key, option]) => option !== undefined || key === 'maxRetryAfter'));
        if (this.#merging) {
            safeObjectAssign(this.#internals.retry, updatedRetry);
        }
        else {
            // A partial object must not drop the other retry settings, as the normalization below and the retry logic require them.
            this.#internals.retry = { ...this.#internals.retry, ...updatedRetry };
        }
        const { retry } = this.#internals;
        retry.methods = [...new Set(retry.methods.map(method => method.toUpperCase()))];
        retry.statusCodes = [...new Set(retry.statusCodes)];
        retry.errorCodes = [...new Set(retry.errorCodes)];
    }
    /**
    From `http.RequestOptions`.

    The IP address used to send the request from.
    */
    get localAddress() {
        return this.#internals.localAddress;
    }
    set localAddress(value) {
        options_assertAny('localAddress', [distribution.string, distribution.undefined], value);
        this.#internals.localAddress = value;
    }
    /**
    The HTTP method used to make the request.
    Custom methods such as `PROPFIND` are supported. Method names are normalized to uppercase.

    @default 'GET'
    */
    get method() {
        return this.#internals.method;
    }
    set method(value) {
        // An empty method would be sent as the default `GET`, hiding the mistake.
        options_assertAny('method', [distribution.nonEmptyString], value);
        this.#internals.method = value.toUpperCase();
        // A hook that switches to a method without a body slot has to drop or replace the body.
        this.#trackedStateMutations?.add('method');
    }
    /**
    The function used to retrieve a `net.Socket` instance when the `agent` option is not used.

    For HTTP/1, either return the socket synchronously or call `callback(null, socket)` asynchronously. Call `callback(error)` if socket creation fails.

    When `http2` is enabled for HTTPS, this function must synchronously return a `tls.TLSSocket`. Callback-based creation is not supported by HTTP/2 negotiation.
    */
    get createConnection() {
        return this.#internals.createConnection;
    }
    set createConnection(value) {
        options_assertAny('createConnection', [distribution.function, distribution.undefined], value);
        this.#internals.createConnection = value;
    }
    /**
    From `http-cache-semantics`

    @default {}
    */
    get cacheOptions() {
        return this.#internals.cacheOptions;
    }
    set cacheOptions(value) {
        options_assertPlainObject('cacheOptions', value);
        options_assertAny('cacheOptions.shared', [distribution.boolean, distribution.undefined], value.shared);
        options_assertAny('cacheOptions.cacheHeuristic', [distribution.number, distribution.undefined], value.cacheHeuristic);
        options_assertAny('cacheOptions.immutableMinTimeToLive', [distribution.number, distribution.undefined], value.immutableMinTimeToLive);
        options_assertAny('cacheOptions.ignoreCargoCult', [distribution.boolean, distribution.undefined], value.ignoreCargoCult);
        assertKnownKeys(value, defaultInternals.cacheOptions, key => new Error(`Cache option \`${key}\` does not exist`));
        this.#mergeOrReplace('cacheOptions', value);
    }
    /**
    Options for the advanced HTTPS API.
    */
    get https() {
        return this.#internals.https;
    }
    set https(value) {
        options_assertPlainObject('https', value);
        options_assertAny('https.rejectUnauthorized', [distribution.boolean, distribution.undefined], value.rejectUnauthorized);
        options_assertAny('https.checkServerIdentity', [distribution.function, distribution.undefined], value.checkServerIdentity);
        options_assertAny('https.serverName', [distribution.string, distribution.undefined], value.serverName);
        options_assertAny('https.certificateAuthority', [distribution.string, distribution.object, distribution.array, distribution.undefined], value.certificateAuthority);
        options_assertAny('https.key', [distribution.string, distribution.object, distribution.array, distribution.undefined], value.key);
        options_assertAny('https.certificate', [distribution.string, distribution.object, distribution.array, distribution.undefined], value.certificate);
        options_assertAny('https.passphrase', [distribution.string, distribution.undefined], value.passphrase);
        options_assertAny('https.pfx', [distribution.string, distribution.uint8Array, distribution.array, distribution.undefined], value.pfx);
        options_assertAny('https.alpnProtocols', [distribution.array, distribution.undefined], value.alpnProtocols);
        options_assertAny('https.ciphers', [distribution.string, distribution.undefined], value.ciphers);
        options_assertAny('https.dhparam', [distribution.string, distribution.buffer, distribution.undefined], value.dhparam);
        options_assertAny('https.signatureAlgorithms', [distribution.string, distribution.undefined], value.signatureAlgorithms);
        options_assertAny('https.minVersion', [distribution.string, distribution.undefined], value.minVersion);
        options_assertAny('https.maxVersion', [distribution.string, distribution.undefined], value.maxVersion);
        options_assertAny('https.honorCipherOrder', [distribution.boolean, distribution.undefined], value.honorCipherOrder);
        options_assertAny('https.tlsSessionLifetime', [distribution.number, distribution.undefined], value.tlsSessionLifetime);
        options_assertAny('https.ecdhCurve', [distribution.string, distribution.undefined], value.ecdhCurve);
        options_assertAny('https.certificateRevocationLists', [distribution.string, distribution.buffer, distribution.array, distribution.undefined], value.certificateRevocationLists);
        options_assertAny('https.secureOptions', [distribution.number, distribution.undefined], value.secureOptions);
        assertKnownKeys(value, defaultInternals.https, key => new Error(`HTTPS option \`${key}\` does not exist`));
        this.#mergeOrReplace('https', cloneHttps(value));
    }
    /**
    [Encoding](https://nodejs.org/api/buffer.html#buffer_buffers_and_character_encodings) to be used on `setEncoding` of the response data.

    To get a [`Uint8Array`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array), you need to set `responseType` to `buffer` instead.
    Don't set this option to `null`.

    __Note__: This doesn't affect streams! Instead, you need to do `got.stream(...).setEncoding(encoding)`.

    @default undefined, which decodes the response as UTF-8
    */
    get encoding() {
        return this.#internals.encoding;
    }
    set encoding(value) {
        if (value === null) {
            throw new TypeError('To get a Uint8Array, set `options.responseType` to `buffer` instead');
        }
        options_assertAny('encoding', [distribution.string, distribution.undefined], value);
        this.#internals.encoding = value;
    }
    /**
    When set to `true` the promise will return the Response body instead of the Response object.

    @default false
    */
    get resolveBodyOnly() {
        return this.#internals.resolveBodyOnly;
    }
    set resolveBodyOnly(value) {
        assert.boolean(value);
        this.#internals.resolveBodyOnly = value;
    }
    /**
    Returns a `Stream` instead of a `Promise`.
    Set internally by `got.stream()`.

    @default false
    @internal
    */
    get isStream() {
        return this.#internals.isStream;
    }
    set isStream(value) {
        assert.boolean(value);
        this.#internals.isStream = value;
    }
    /**
    The parsing method.

    The promise also has `.text()`, `.json()` and `.buffer()` methods which return another Got promise for the parsed body.

    It's like setting the options to `{responseType: 'json', resolveBodyOnly: true}` but without affecting the main Got promise.

    __Note__: When using streams, this option is ignored.

    @example
    ```
    const responsePromise = got(url);
    const bufferPromise = responsePromise.buffer();
    const jsonPromise = responsePromise.json();

    const [response, buffer, json] = Promise.all([responsePromise, bufferPromise, jsonPromise]);
    // `response` is an instance of Got Response
    // `buffer` is an instance of Uint8Array
    // `json` is an object
    ```

    @example
    ```
    // This
    const body = await got(url).json();

    // is semantically the same as this
    const body = await got(url, {responseType: 'json', resolveBodyOnly: true});
    ```
    */
    get responseType() {
        return this.#internals.responseType;
    }
    set responseType(value) {
        if (value !== 'text' && value !== 'buffer' && value !== 'json') {
            throw new Error(`Invalid \`responseType\` option: ${value}`);
        }
        this.#internals.responseType = value;
    }
    get pagination() {
        return this.#internals.pagination;
    }
    set pagination(value) {
        assert.object(value);
        const updatedPagination = Object.fromEntries(Object.entries(value).filter(([, option]) => option !== undefined));
        if (this.#merging) {
            safeObjectAssign(this.#internals.pagination, updatedPagination);
        }
        else {
            // A partial object must not drop the other pagination settings, as the pagination logic requires them.
            this.#internals.pagination = { ...this.#internals.pagination, ...updatedPagination };
        }
    }
    get setHost() {
        return this.#internals.setHost;
    }
    set setHost(value) {
        assert.boolean(value);
        this.#internals.setHost = value;
    }
    get maxHeaderSize() {
        return this.#internals.maxHeaderSize;
    }
    set maxHeaderSize(value) {
        options_assertAny('maxHeaderSize', [distribution.number, distribution.undefined], value);
        this.#internals.maxHeaderSize = value;
    }
    get enableUnixSockets() {
        return this.#internals.enableUnixSockets;
    }
    set enableUnixSockets(value) {
        assert.boolean(value);
        this.#internals.enableUnixSockets = value;
    }
    /**
    Throw an error if the server response's `content-length` header value doesn't match the number of bytes received.

    This is useful for detecting truncated responses and follows RFC 9112 requirements for message completeness.

    __Note__: Responses without a `content-length` header are not validated.
    __Note__: When enabled and validation fails, a `ReadError` with code `ERR_HTTP_CONTENT_LENGTH_MISMATCH` will be thrown.
    __Note__: Keep custom native responses in byte mode for exact validation. Calling `setEncoding()` on the native response can lose the original byte count when decoding malformed input.

    @default true
    */
    get strictContentLength() {
        return this.#internals.strictContentLength;
    }
    set strictContentLength(value) {
        assert.boolean(value);
        this.#internals.strictContentLength = value;
    }
    // eslint-disable-next-line @typescript-eslint/naming-convention
    toJSON() {
        // A copy of the nested state, so editing the result cannot change these options.
        return cloneInternals(this.#internals);
    }
    [Symbol.for('nodejs.util.inspect.custom')](_depth, options) {
        return (0,external_node_util_.inspect)(this.#internals, options);
    }
    createNativeRequestOptions() {
        const internals = this.#internals;
        const url = internals.url;
        const usesAlpn = usesHttp2Alpn(internals, url);
        const socketTimeout = usesAlpn ? internals.timeout.socket : undefined;
        const http2Timeout = usesAlpn ? getHttp2Timeout(internals) : undefined;
        let agent;
        if (url.protocol === 'https:') {
            if (internals.http2) {
                // Ensure HTTP/2 pooling is configured for connection reuse.
                // If agent.http2 is unset, use the global agent for connection pooling.
                agent = {
                    ...internals.agent,
                    http2: internals.agent.http2 ?? http2_client.globalAgent,
                };
            }
            else {
                agent = internals.agent.https;
            }
        }
        else {
            agent = internals.agent.http;
        }
        const { https } = internals;
        let { pfx } = https;
        if (distribution.array(pfx)) {
            pfx = pfx.map(entry => distribution.plainObject(entry)
                ? {
                    buf: entry.buffer,
                    passphrase: entry.passphrase,
                }
                : entry);
        }
        const unixSocketPath = getUnixSocketPath(url);
        if (usesUnixSocket(url) && !internals.enableUnixSockets) {
            throw new Error('Using UNIX domain sockets but option `enableUnixSockets` is not enabled');
        }
        let unixSocketGroups;
        if (unixSocketPath !== undefined) {
            unixSocketGroups = /^(?<socketPath>[^:]+):(?<path>.+)$/v.exec(`${url.pathname}${url.search}`)?.groups;
        }
        const unixOptions = unixSocketGroups
            // The URL parser percent-encodes the path, but the socket path is a filesystem path.
            ? { socketPath: safeDecode(unixSocketGroups.socketPath), path: unixSocketGroups.path, host: '' }
            : undefined;
        const nativeRequestOptions = {
            ...internals.cacheOptions,
            ...unixOptions,
            // HTTPS options
            // eslint-disable-next-line @typescript-eslint/naming-convention
            ALPNProtocols: https.alpnProtocols,
            ca: https.certificateAuthority,
            cert: https.certificate,
            key: https.key,
            passphrase: https.passphrase,
            pfx,
            rejectUnauthorized: https.rejectUnauthorized,
            checkServerIdentity: https.checkServerIdentity ?? external_node_tls_.checkServerIdentity,
            servername: https.serverName,
            ciphers: https.ciphers,
            honorCipherOrder: https.honorCipherOrder,
            minVersion: https.minVersion,
            maxVersion: https.maxVersion,
            sigalgs: https.signatureAlgorithms,
            sessionTimeout: https.tlsSessionLifetime,
            dhparam: https.dhparam,
            ecdhCurve: https.ecdhCurve,
            crl: https.certificateRevocationLists,
            secureOptions: https.secureOptions,
            // HTTP options
            lookup: internals.dnsLookup ? getAdaptedLookup(internals.dnsLookup) : (internals.dnsCache ? getDnsCacheLookup(internals.dnsCache) : undefined),
            family: internals.dnsLookupIpVersion,
            agent,
            setHost: internals.setHost,
            method: internals.method,
            maxHeaderSize: internals.maxHeaderSize,
            localAddress: internals.localAddress,
            // A copy, so a caller editing the native options cannot change these options.
            headers: cloneHeaders(internals.headers),
            createConnection: internals.createConnection,
            signal: internals.http2 ? internals.signal : undefined,
            timeout: http2Timeout?.timeout,
            ...(http2Timeout !== undefined && { _timeoutPhase: http2Timeout.phase }),
            ...(socketTimeout !== undefined && { _socketTimeout: socketTimeout }),
            // HTTP/2 options
            h2session: internals.h2session,
        };
        return nativeRequestOptions;
    }
    getRequestFunction() {
        const { request: customRequest } = this.#internals;
        if (!customRequest) {
            return this.#getFallbackRequestFunction();
        }
        const requestWithFallback = (url, options, callback) => {
            const nativeAgent = getNativeAgent(url, options.agent);
            const hasInternalSocketTimeout = Object.hasOwn(options, '_socketTimeout');
            const hasInternalTimeoutPhase = Object.hasOwn(options, '_timeoutPhase');
            const customRequestOptions = options.timeout !== undefined || hasInternalSocketTimeout || nativeAgent !== options.agent
                ? {
                    ...options,
                    agent: nativeAgent,
                    timeout: undefined,
                }
                : options;
            if (hasInternalSocketTimeout) {
                Reflect.deleteProperty(customRequestOptions, '_socketTimeout');
            }
            if (hasInternalTimeoutPhase) {
                Reflect.deleteProperty(customRequestOptions, '_timeoutPhase');
            }
            const result = customRequest(url, customRequestOptions, callback);
            if (distribution.promise(result)) {
                return this.#resolveRequestWithFallback(result, {
                    url,
                    options,
                    callback,
                });
            }
            return result ?? this.#callFallbackRequest(url, options, callback);
        };
        return requestWithFallback;
    }
    freeze() {
        const options = this.#internals;
        Object.freeze(options);
        Object.freeze(options.hooks);
        for (const handlers of Object.values(options.hooks)) {
            Object.freeze(handlers);
        }
        Object.freeze(options.https);
        for (const value of Object.values(options.https)) {
            if (!Array.isArray(value)) {
                continue;
            }
            for (const item of value) {
                if (distribution.plainObject(item)) {
                    Object.freeze(item);
                }
            }
            Object.freeze(value);
        }
        Object.freeze(options.cacheOptions);
        Object.freeze(options.agent);
        Object.freeze(options.headers);
        Object.freeze(options.timeout);
        Object.freeze(options.pagination);
        Object.freeze(options.retry);
        Object.freeze(options.retry.errorCodes);
        Object.freeze(options.retry.methods);
        Object.freeze(options.retry.statusCodes);
        for (const value of Object.values(options.headers)) {
            Object.freeze(value);
        }
    }
    #getCredential(credential) {
        const url = this.#internals.url;
        const value = url ? url[credential] : this.#internals[credential];
        return safeDecode(value);
    }
    #setCredential(credential, value) {
        const url = this.#internals.url;
        const fixedValue = encodeURIComponent(value);
        if (url) {
            url[credential] = fixedValue;
        }
        else {
            this.#internals[credential] = fixedValue;
        }
        this.#trackedStateMutations?.add(credential);
    }
    // Merging assigns into the existing object, while a direct assignment replaces it with a copy.
    #mergeOrReplace(key, value) {
        if (this.#merging) {
            safeObjectAssign(this.#internals[key], value);
        }
        else {
            this.#internals[key] = { ...value };
        }
    }
    #createHeadersProxy() {
        return new Proxy(this.#internals.headers, {
            get(target, property, receiver) {
                if (typeof property === 'string') {
                    // Only own properties are headers, so an inherited `Object.prototype` member
                    // must not read as one.
                    if (Object.hasOwn(target, property)) {
                        return Reflect.get(target, property, receiver);
                    }
                    const normalizedProperty = property.toLowerCase();
                    return Object.hasOwn(target, normalizedProperty) ? Reflect.get(target, normalizedProperty, receiver) : undefined;
                }
                return Reflect.get(target, property, receiver);
            },
            set: (target, property, value) => {
                if (typeof property === 'string') {
                    const normalizedProperty = property.toLowerCase();
                    assertValidHeaderName(normalizedProperty);
                    const isSuccess = Reflect.set(target, normalizedProperty, typeof value === 'number' ? String(value) : value);
                    if (isSuccess) {
                        this.#explicitHeaders.add(normalizedProperty);
                        this.#trackedStateMutations?.add(normalizedProperty);
                    }
                    return isSuccess;
                }
                return Reflect.set(target, property, value);
            },
            deleteProperty: (target, property) => {
                if (typeof property === 'string') {
                    const normalizedProperty = property.toLowerCase();
                    const isSuccess = Reflect.deleteProperty(target, normalizedProperty);
                    if (isSuccess) {
                        this.#explicitHeaders.delete(normalizedProperty);
                        this.#trackedStateMutations?.add(normalizedProperty);
                    }
                    return isSuccess;
                }
                return Reflect.deleteProperty(target, property);
            },
        });
    }
    #getFallbackRequestFunction() {
        const url = this.#internals.url;
        if (!url) {
            return;
        }
        if (this.#internals.h2session) {
            return http2_client.auto;
        }
        if (url.protocol === 'https:') {
            return this.#internals.http2 ? http2_client.auto : external_node_https_.request;
        }
        return external_node_http_.request;
    }
    #callFallbackRequest(url, options, callback) {
        const fallbackRequest = this.#getFallbackRequestFunction();
        if (!fallbackRequest) {
            throw new TypeError('The request function must return a value');
        }
        const fallbackResult = fallbackRequest(url, options, callback);
        if (fallbackResult === undefined) {
            throw new TypeError('The request function must return a value');
        }
        return distribution.promise(fallbackResult) ? this.#resolveFallbackRequestResult(fallbackResult) : fallbackResult;
    }
    async #resolveRequestWithFallback(requestResult, { url, options, callback }) {
        const result = await requestResult;
        return result ?? this.#callFallbackRequest(url, options, callback);
    }
    async #resolveFallbackRequestResult(fallbackResult) {
        const resolvedFallbackResult = await fallbackResult;
        if (resolvedFallbackResult === undefined) {
            throw new TypeError('The request function must return a value');
        }
        return resolvedFallbackResult;
    }
}
/**
The option names are the accessor properties. Everything else on the prototype chain is a
method or an `Object.prototype` member, neither of which is an option.
*/
const optionDescriptors = Object.getOwnPropertyDescriptors(Options.prototype);
const optionNames = new Set(Object.entries(optionDescriptors).filter(([, descriptor]) => descriptor.get !== undefined && descriptor.set !== undefined).map(([name]) => name));
const snapshotCrossOriginState = (options) => ({
    headers: { ...options.getInternalHeaders() },
    hadCookieJar: options.cookieJar !== undefined,
    cookieWasExplicitlySet: options.isHeaderExplicitlySet('cookie'),
    username: options.username,
    password: options.password,
    body: options.body,
    json: options.json,
    form: options.form,
    bodySnapshot: cloneCrossOriginBodyValue(options.body),
    jsonSnapshot: cloneCrossOriginBodyValue(options.json),
    formSnapshot: cloneCrossOriginBodyValue(options.form),
});
const cloneCrossOriginBodyValue = (value) => {
    if (value === undefined || value === null || typeof value !== 'object') {
        return value;
    }
    try {
        const clone = structuredClone(value);
        // `structuredClone` drops prototypes it does not know, so a `Buffer` would never
        // compare equal to the value it was cloned from.
        if (Object.getPrototypeOf(clone) !== Object.getPrototypeOf(value)) {
            Object.setPrototypeOf(clone, Object.getPrototypeOf(value));
        }
        return clone;
    }
    catch {
        return undefined;
    }
};
const isUnchangedCrossOriginBodyValue = (currentValue, previousValue, previousSnapshot) => {
    if (currentValue !== previousValue) {
        return false;
    }
    return currentValue === undefined || currentValue === null || typeof currentValue !== 'object' || (previousSnapshot === undefined) ? true : (0,external_node_util_.isDeepStrictEqual)(currentValue, previousSnapshot);
};
const isCrossOriginCredentialChanged = (previousUrl, nextUrl, credential) => (nextUrl[credential] !== '' && nextUrl[credential] !== previousUrl[credential]);
const isBodyUnchanged = (options, previousState) => isUnchangedCrossOriginBodyValue(options.body, previousState.body, previousState.bodySnapshot)
    && isUnchangedCrossOriginBodyValue(options.json, previousState.json, previousState.jsonSnapshot)
    && isUnchangedCrossOriginBodyValue(options.form, previousState.form, previousState.formSnapshot);

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/utils/is-client-request.js
function isClientRequest(clientRequest) {
    return clientRequest.writable && !clientRequest.writableEnded;
}
/* harmony default export */ const is_client_request = (isClientRequest);

// EXTERNAL MODULE: external "node:diagnostics_channel"
var external_node_diagnostics_channel_ = __webpack_require__(53053);
;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/diagnostics-channel.js


const channels = {
    requestCreate: external_node_diagnostics_channel_.channel('got:request:create'),
    requestStart: external_node_diagnostics_channel_.channel('got:request:start'),
    responseStart: external_node_diagnostics_channel_.channel('got:response:start'),
    responseEnd: external_node_diagnostics_channel_.channel('got:response:end'),
    retry: external_node_diagnostics_channel_.channel('got:request:retry'),
    error: external_node_diagnostics_channel_.channel('got:request:error'),
    redirect: external_node_diagnostics_channel_.channel('got:response:redirect'),
};
function generateRequestId() {
    return (0,external_node_crypto_.randomUUID)();
}
const publishToChannel = (channel, message) => {
    if (channel.hasSubscribers) {
        channel.publish(message);
    }
};
function publishRequestCreate(message) {
    publishToChannel(channels.requestCreate, message);
}
function publishRequestStart(message) {
    publishToChannel(channels.requestStart, message);
}
function publishResponseStart(message) {
    publishToChannel(channels.responseStart, message);
}
function publishResponseEnd(message) {
    publishToChannel(channels.responseEnd, message);
}
function publishRetry(message) {
    publishToChannel(channels.retry, message);
}
function publishError(message) {
    publishToChannel(channels.error, message);
}
function publishRedirect(message) {
    publishToChannel(channels.redirect, message);
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/core/index.js


























const supportsBrotli = distribution.string(external_node_process_.versions.brotli);
const core_supportsZstd = distribution.string(external_node_process_.versions.zstd);
const methodsWithoutBody = new Set(['GET', 'HEAD']);
const singleValueRequestHeaders = new Set([
    'authorization',
    'content-length',
    'host',
    'proxy-authorization',
]);
const cacheableStore = new WeakableMap();
const redirectCodes = new Set([301, 302, 303, 307, 308]);

const transientWriteErrorCodes = new Set(['EPIPE', 'ECONNRESET']);
// See https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1
const hopByHopHeaders = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
const omittedPipedHeaders = new Set([
    ...hopByHopHeaders,
    'host',
    'authorization',
    'cookie',
    'cookie2',
    'set-cookie',
    'set-cookie2',
]);
// Track errors that have been processed by beforeError hooks to preserve custom error types
const errorsProcessedByHooks = new WeakSet();
const proxiedRequestEvents = [
    'socket',
    'connect',
    'continue',
    'information',
    'upgrade',
];
const core_noop = () => { };
const isPipedServerResponse = (destination) => destination instanceof external_node_http_.ServerResponse
    || destination instanceof external_node_http2_.Http2ServerResponse;
const destroyRequestResult = (result) => {
    if (!distribution.object(result) || !('destroy' in result) || !distribution.function(result.destroy)) {
        return;
    }
    if ('once' in result && distribution.function(result.once)) {
        result.once('error', core_noop);
    }
    result.destroy();
};
const createPreRequestErrorTimings = () => {
    const now = Date.now();
    return {
        start: now,
        error: now,
        phases: {
            total: 0,
        },
    };
};
const serializeNativeFormDataBody = (form) => {
    const response = new globalThis.Response(form);
    return {
        body: response.body,
        contentType: response.headers.get('content-type') ?? 'multipart/form-data',
    };
};
const isTransientWriteError = (error) => {
    const { code } = error;
    return typeof code === 'string' && transientWriteErrorCodes.has(code);
};
const getConnectionListedHeaders = (headers) => {
    const connectionListedHeaders = new Set();
    for (const [header, connectionHeader] of Object.entries(headers)) {
        const normalizedHeader = header.toLowerCase();
        if (normalizedHeader !== 'connection' && normalizedHeader !== 'proxy-connection') {
            continue;
        }
        const connectionHeaderValues = Array.isArray(connectionHeader) ? connectionHeader : [connectionHeader];
        for (const value of connectionHeaderValues) {
            if (typeof value !== 'string') {
                continue;
            }
            for (const token of value.split(',')) {
                const normalizedToken = token.trim().toLowerCase();
                if (normalizedToken.length > 0) {
                    connectionListedHeaders.add(normalizedToken);
                }
            }
        }
    }
    return connectionListedHeaders;
};
const getSanitizedUrl = (options) => options?.url ? stripUrlAuth(options.url) : '';
const methodCanHaveBody = (options) => !methodsWithoutBody.has(options.method) || (options.method === 'GET' && options.allowGetBody);
const makeProgress = (transferred, total) => {
    let percent = 0;
    if (total === transferred) {
        // Known-size complete transfers (including 0/0) should report 100% rather than 0%.
        percent = 1;
    }
    else if (total) {
        percent = transferred / total;
    }
    return { percent, transferred, total };
};
const parseContentLength = (value) => {
    const length = Number(value);
    return Number.isNaN(length) ? undefined : length;
};
const hasBodyOption = (options) => !distribution.undefined(options?.body) || !distribution.undefined(options?.json) || !distribution.undefined(options?.form);
const isIterableBody = (body) => distribution.asyncIterable(body) || (distribution.iterable(body) && !distribution.string(body) && !isBuffer(body));
const hasResponse = (request) => Boolean(request.res);
const toRequestError = (thrown, request) => {
    const normalizedError = normalizeError(thrown);
    return new RequestError(normalizedError.message, normalizedError, request);
};
const createServerAbortedError = (request) => new ReadError({
    name: 'Error',
    message: 'The server aborted pending request',
    code: 'ECONNRESET',
}, request);
class Request extends external_node_stream_.Duplex {
    // @ts-expect-error - Ignoring for now.
    ['constructor'];
    _noPipe;
    // @ts-expect-error https://github.com/microsoft/TypeScript/issues/9568
    options;
    response;
    requestUrl;
    redirectUrls = [];
    retryCount = 0;
    _stopReading = false;
    _stopRetry;
    _downloadedSize = 0;
    _uploadedSize = 0;
    _pipedServerResponses = new Set();
    _request;
    _responseSize;
    _bodySize;
    _nativeFormDataBody;
    _activeWebBodyReader;
    _unproxyEvents;
    _triggerRead = false;
    _jobs = [];
    _cancelTimeouts;
    _abortListenerDisposer;
    _flushed = false;
    _startedAt;
    _requestTimeout;
    _dispatchedBody;
    _aborted = false;
    _retrying = false;
    _expectedContentLength;
    _compressedBytesCount;
    _skipRequestEndInFinal = false;
    _dispatchingOwnBody = false;
    _hasWrittenBody = false;
    _hasWritableBody = false;
    _discardBodyWrites = false;
    _incrementalDecode;
    _requestId;
    // We need this because `this._request` if `undefined` when using cache
    _requestInitialized = false;
    constructor(url, options, defaults, retrySource) {
        super({
            // Don't destroy immediately, as the error may be emitted on unsuccessful retry
            autoDestroy: false,
            // It needs to be zero because we're just proxying the data to another stream
            highWaterMark: 0,
        });
        this._requestId = retrySource?._requestId ?? generateRequestId();
        // Observe the terminal error without consuming unhandled stream errors.
        const onError = (error) => {
            // The Promise API routes writable errors through retry and beforeError hooks first.
            if (this._noPipe && !this._stopReading) {
                return;
            }
            this.off(external_node_events_.errorMonitor, onError);
            publishError({
                requestId: this._requestId,
                url: getSanitizedUrl(this.options),
                error,
                timings: this.timings,
            });
        };
        this.on(external_node_events_.errorMonitor, onError);
        this.on('pipe', (source) => {
            if (this.options.copyPipedHeaders && source?.headers) {
                const connectionListedHeaders = getConnectionListedHeaders(source.headers);
                for (const [header, value] of Object.entries(source.headers)) {
                    const normalizedHeader = header.toLowerCase();
                    if (omittedPipedHeaders.has(normalizedHeader) || connectionListedHeaders.has(normalizedHeader) || !this.options.shouldCopyPipedHeader(normalizedHeader)) {
                        continue;
                    }
                    this.options.setPipedHeader(normalizedHeader, value);
                }
            }
        });
        this.on('newListener', event => {
            if (event === 'retry' && this.listenerCount('retry') > 0) {
                throw new Error('A retry listener has been attached already.');
            }
        });
        try {
            this.options = new Options(url, options, defaults);
            this._nativeFormDataBody = retrySource?._nativeFormDataBody;
            if (!this.options.url) {
                if (this.options.prefixUrl === '') {
                    throw new TypeError('Missing `url` property');
                }
                this.options.url = '';
            }
            this.requestUrl = new URL(retrySource?.requestUrl ?? this.options.url);
            // Publish request creation event
            publishRequestCreate({
                requestId: this._requestId,
                url: getSanitizedUrl(this.options),
                method: this.options.method,
            });
        }
        catch (error) {
            const { options } = error;
            if (options) {
                this.options = options;
            }
            this.flush = async () => {
                this.flush = async () => { };
                // Defer error emission to next tick to allow user to attach error handlers
                external_node_process_.nextTick(() => {
                    // _beforeError requires options to access retry logic and hooks
                    if (this.options) {
                        this._beforeError(error);
                    }
                    else {
                        // Options is undefined, skip _beforeError and destroy directly
                        const normalizedError = normalizeError(error);
                        const requestError = normalizedError instanceof RequestError ? normalizedError : new RequestError(normalizedError.message, normalizedError, this);
                        this.destroy(requestError);
                    }
                });
            };
            return;
        }
        // Important! If you replace `body` in a handler with another stream, make sure it's readable first.
        // The below is run only once.
        const { body } = this.options;
        if (distribution.nodeStream(body)) {
            body.once('error', this._onBodyError);
        }
    }
    async flush() {
        if (this._flushed) {
            return;
        }
        this._flushed = true;
        try {
            this._attachAbortListener();
            if (this.destroyed) {
                return;
            }
            await this._finalizeBody();
            if (this.destroyed) {
                return;
            }
            this._hasWritableBody = this._canWriteBody();
            await this._makeRequest();
            if (this.destroyed) {
                this._request?.destroy();
                return;
            }
            // Queued writes etc.
            for (const job of this._jobs) {
                job();
            }
            // Prevent memory leak
            this._jobs.length = 0;
            this._requestInitialized = true;
        }
        catch (error) {
            this._beforeError(error);
        }
    }
    _beforeError(thrown) {
        if (this._stopReading) {
            return;
        }
        let error = normalizeError(thrown);
        const { response, options } = this;
        const attemptCount = this.retryCount + 1;
        this._stopReading = true;
        if (error instanceof timed_out_TimeoutError) {
            error = this._createTimeoutError(error);
        }
        else if (!(error instanceof RequestError)) {
            error = new RequestError(error.message, error, this);
        }
        const typedError = error;
        void (async () => {
            // Node.js parser is really weird.
            // It emits post-request Parse Errors on the same instance as previous request. WTF.
            // Therefore, we need to check if it has been destroyed as well.
            if (response?.readable && !response.rawBody && !this._request?.socket?.destroyed) {
                await this._setRawBody(response);
            }
            if (response?.rawBody && response.body === undefined) {
                try {
                    // `error.response` is typed with the request's `responseType`, so honour it here. The
                    // body is assigned right below, so the cast is only visible while parsing.
                    response.body = parseBody(response, options.responseType, options.parseJson, options.encoding);
                }
                catch {
                    // Preserve the original request error when parsing its response body also fails.
                    try {
                        response.body = decodeUint8Array(response.rawBody, options.encoding);
                    }
                    catch { }
                }
            }
            if (this.listenerCount('retry') !== 0) {
                let backoff;
                try {
                    let retryAfter;
                    if (response && 'retry-after' in response.headers) {
                        const retryAfterHeader = response.headers['retry-after'];
                        if (/^\d+$/v.test(retryAfterHeader)) {
                            retryAfter = Number(retryAfterHeader) * 1000;
                        }
                        else if (Number.isNaN(Number(retryAfterHeader))) {
                            // The asctime HTTP-date format has no timezone marker, but represents UTC (RFC 9110, section 5.6.7).
                            const date = /^\w{3} \w{3} [\d ]\d \d{2}:\d{2}:\d{2} \d{4}$/v.test(retryAfterHeader) ? `${retryAfterHeader} GMT` : retryAfterHeader;
                            retryAfter = Date.parse(date) - Date.now();
                        }
                        if (retryAfter === undefined || Number.isNaN(retryAfter)) {
                            // Invalid `Retry-After` values must be ignored. See https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3
                            retryAfter = undefined;
                        }
                        else if (retryAfter < 0) {
                            retryAfter = 0;
                        }
                    }
                    const retryOptions = options.retry;
                    const computedValue = calculate_retry_delay({
                        attemptCount,
                        retryOptions,
                        error: typedError,
                        retryAfter,
                        computedValue: retryOptions.maxRetryAfter ?? options.timeout.request ?? Infinity,
                    });
                    // When enforceRetryRules is true, respect the retry rules (limit, methods, statusCodes, errorCodes)
                    // before calling the user's calculateDelay function. If computedValue is 0 (meaning retry is not allowed
                    // based on these rules), skip calling calculateDelay entirely.
                    // When false, always call calculateDelay, allowing it to override retry decisions.
                    if (retryOptions.enforceRetryRules && computedValue === 0) {
                        backoff = 0;
                    }
                    else {
                        backoff = await retryOptions.calculateDelay({
                            attemptCount,
                            retryOptions,
                            error: typedError,
                            retryAfter,
                            computedValue,
                        });
                    }
                }
                catch (error_) {
                    void this._error(toRequestError(error_, this));
                    return;
                }
                // Node turns overflowing timer delays into 1 ms. Stop retrying instead of running before the requested delay.
                if (backoff && backoff <= 2_147_483_647) {
                    await new Promise(resolve => {
                        const timeout = setTimeout(resolve, backoff);
                        this._stopRetry = () => {
                            clearTimeout(timeout);
                            resolve();
                        };
                    });
                    // Something forced us to abort the retry
                    if (this.destroyed) {
                        return;
                    }
                    // Capture body BEFORE hooks run to detect reassignment
                    const bodyBeforeHooks = this.options.body;
                    let changedState;
                    try {
                        changedState = await this.options.trackStateMutations(async (changedState) => {
                            for (const hook of this.options.hooks.beforeRetry) {
                                // eslint-disable-next-line no-await-in-loop
                                await hook(typedError, this.retryCount + 1);
                            }
                            return changedState;
                        });
                    }
                    catch (error_) {
                        void this._error(toRequestError(error_, this));
                        return;
                    }
                    // Something forced us to abort the retry
                    if (this.destroyed) {
                        return;
                    }
                    // Preserve stream body reassigned in beforeRetry hooks.
                    const bodyAfterHooks = this.options.body;
                    const bodyWasReassigned = bodyBeforeHooks !== bodyAfterHooks;
                    // Resource cleanup and preservation logic for retry with body reassignment.
                    // The Promise wrapper (as-promise/index.ts) compares body identity to detect consumed streams,
                    // so we must preserve the body reference across destroy(). However, destroy() calls _destroy()
                    // which destroys this.options.body, creating a complex dance of clear/restore operations.
                    //
                    // Key constraints:
                    // 1. If body was reassigned, we must NOT destroy the NEW stream (it will be used for retry)
                    // 2. If body was reassigned, we MUST destroy the OLD stream to prevent memory leaks
                    // 3. We must restore the body reference after destroy() for identity checks in promise wrapper
                    // 4. We cannot use the normal setter after destroy() because it validates stream readability
                    this._retrying = true;
                    /*
                    Everything from here on runs after `destroy()`, so any failure leaves the
                    request without a next attempt. The piped destination is therefore this
                    request's to close, and the error still has to reach the caller.
                    */
                    try {
                        if (bodyWasReassigned) {
                            if (!changedState.has('content-length')) {
                                this._refreshBodySize(this.options);
                            }
                            const oldBody = bodyBeforeHooks;
                            // Temporarily clear body to prevent destroy() from destroying the new stream
                            this.options.body = undefined;
                            this.destroy();
                            // `_destroy` already tore down the dispatched body, so only clean up a
                            // different one here.
                            if (oldBody !== bodyAfterHooks && oldBody !== this._dispatchedBody?.body) {
                                this._destroyBody(oldBody);
                            }
                            // Restore new body for promise wrapper's identity check
                            if (distribution.nodeStream(bodyAfterHooks) && (bodyAfterHooks.readableEnded || bodyAfterHooks.destroyed)) {
                                throw new TypeError('The reassigned stream body must be readable. Ensure you provide a fresh, readable stream in the beforeRetry hook.');
                            }
                            this.options.body = bodyAfterHooks;
                        }
                        else {
                            // Body wasn't reassigned - use normal destroy flow which handles body cleanup
                            this.destroy();
                            // Note: We do NOT restore the body reference here. The stream was destroyed by _destroy()
                            // and should not be accessed. The promise wrapper will see that body identity hasn't changed
                            // and will detect it's a consumed stream, which is the correct behavior.
                        }
                        // Native FormData can be re-serialized, so replay it instead of failing with a consumed body.
                        if (this._nativeFormDataBody !== undefined && this.options.body === this._nativeFormDataBody.body) {
                            this._reserializeFormDataBody(this.options, changedState.has('content-type'));
                        }
                        // Publish retry event
                        publishRetry({
                            requestId: this._requestId,
                            retryCount: this.retryCount + 1,
                            error: typedError,
                            delay: backoff,
                        });
                        this.emit('retry', this.retryCount + 1, error, (updatedOptions) => {
                            const request = new Request(undefined, updatedOptions, options, this);
                            request.retryCount = this.retryCount + 1;
                            external_node_process_.nextTick(() => {
                                void request.flush();
                            });
                            return request;
                        });
                    }
                    catch (error_) {
                        this._closePipedServerResponses();
                        void this._error(toRequestError(error_, this));
                        return;
                    }
                    return;
                }
            }
            void this._error(typedError);
        })();
    }
    _read() {
        this._triggerRead = true;
        const { response } = this;
        if (response && !this._stopReading) {
            // We cannot put this in the `if` above
            // because `.read()` also triggers the `end` event
            if (response.readableLength) {
                this._triggerRead = false;
            }
            let data;
            while ((data = response.read()) !== null) {
                if (this._noPipe && typeof data === 'string') {
                    data = external_node_buffer_.Buffer.from(data, response.readableEncoding ?? undefined);
                }
                this._downloadedSize += typeof data === 'string' ? external_node_buffer_.Buffer.byteLength(data, response.readableEncoding ?? undefined) : byteLength(data);
                if (this._incrementalDecode) {
                    try {
                        const decodedChunk = typeof data === 'string' ? data : this._incrementalDecode.decoder.decode(data, { stream: true });
                        if (decodedChunk.length > 0) {
                            this._incrementalDecode.chunks.push(decodedChunk);
                        }
                    }
                    catch {
                        this._incrementalDecode = undefined;
                    }
                }
                const progress = this.downloadProgress;
                if (progress.percent < 1) {
                    this.emit('downloadProgress', progress);
                }
                if (this._stopReading || !this.push(data) || this._stopReading) {
                    return;
                }
            }
        }
    }
    // Fail at the call site: a write buffered by `cork()` would otherwise flush through `_write`
    // after the body dispatch began and pass its guard.
    write(chunk, encoding, callback) {
        if (this.isReadonly && !this._dispatchingOwnBody) {
            const error = new TypeError('The stream is read-only: the request body is provided by the `body`, `json` or `form` option.');
            this.destroy(error);
            // Like a write to a destroyed stream, the refused write still reports to its callback.
            const writeCallback = typeof encoding === 'function' ? encoding : callback;
            if (writeCallback) {
                external_node_process_.nextTick(writeCallback, error);
            }
            return false;
        }
        return super.write(chunk, encoding, callback);
    }
    _write(chunk, encoding, callback) {
        // The `body`, `json` or `form` option owns the request body, so a user write would land
        // past the framed `content-length` and corrupt the request.
        if (this.isReadonly && !this._dispatchingOwnBody) {
            callback(new TypeError('The stream is read-only: the request body is provided by the `body`, `json` or `form` option.'));
            return;
        }
        const write = () => {
            if (this._discardBodyWrites) {
                callback();
                return;
            }
            this._hasWrittenBody = true;
            this._writeRequest(chunk, encoding, callback);
        };
        if (this._requestInitialized) {
            write();
        }
        else {
            this._jobs.push(write);
        }
    }
    _final(callback) {
        const endRequest = () => {
            if (this._discardBodyWrites) {
                this._hasWritableBody = false;
                callback();
                return;
            }
            if (this._skipRequestEndInFinal) {
                this._skipRequestEndInFinal = false;
                callback();
                return;
            }
            const request = this._request;
            // We need to check if `this._request` is present,
            // because it isn't when we use cache.
            if (!request || request.destroyed) {
                this._hasWritableBody = false;
                callback();
                return;
            }
            request.end((error) => {
                // The request has been destroyed before `_final` finished.
                // See https://github.com/nodejs/node/issues/39356
                if (request?._writableState?.errored) {
                    return;
                }
                this._hasWritableBody = false;
                if (error) {
                    // `ClientRequest.end()` can report the same failure as the request's `error` event. Route it through Got's retry handling without completing `_final`, so this Duplex does not finish a failed upload.
                    this._beforeError(error);
                    return;
                }
                this._emitUploadComplete(request);
                callback();
            });
        };
        if (this._requestInitialized) {
            endRequest();
        }
        else {
            this._jobs.push(endRequest);
        }
    }
    _destroy(error, callback) {
        this._stopReading = true;
        this.flush = async () => { };
        // Got owns a piped `ServerResponse`: it copied the status code and headers into it, so a
        // request that fails would leave the client waiting forever. A retry only replaces the
        // request, so the destination belongs to whichever attempt comes next. Node emits `close`
        // after `error`, so an `error` listener can still answer the client itself, such as with a
        // 502, and only a destination nobody ended is closed.
        if (!this._retrying) {
            this.once('close', () => {
                this._closePipedServerResponses();
            });
        }
        // Prevent further retries
        this._stopRetry?.();
        this._cancelTimeouts?.();
        clearTimeout(this._requestTimeout);
        this._abortListenerDisposer?.[Symbol.dispose]();
        this._destroyInFlightAlpnSocket();
        if (this.options) {
            // Tear down the body this request dispatched. A hook can install the body for the next
            // attempt before this request is destroyed, and that body must survive the retry.
            this._destroyBody(this._dispatchedBody?.body);
            if (this._dispatchedBody === undefined) {
                // Nothing was ever dispatched, so whatever the options hold was never sent.
                this._destroyBody(this.options.body);
            }
        }
        this._request?.destroy();
        // Workaround: http-timer only sets timings.end when the response emits 'end'.
        // When a stream is destroyed before completion, the 'end' event may not fire,
        // leaving timings.end undefined. This should ideally be fixed in http-timer
        // by listening to the 'close' event, but we handle it here for now.
        // Only set timings.end if there was no error or abort (to maintain semantic correctness).
        const timings = this._request?.timings;
        if (timings && distribution.undefined(timings.end) && !distribution.undefined(timings.response) && distribution.undefined(timings.error) && distribution.undefined(timings.abort)) {
            timings.end = Date.now();
            if (distribution.undefined(timings.phases.total)) {
                timings.phases.download = timings.end - timings.response;
                timings.phases.total = timings.end - timings.start;
            }
        }
        // Preserve custom errors returned by beforeError hooks.
        // For other errors, wrap non-RequestError instances for consistency.
        if (error !== null) {
            const processedByHooks = error instanceof Error && errorsProcessedByHooks.has(error);
            if (!processedByHooks && !(error instanceof RequestError)) {
                error = error instanceof Error
                    ? new RequestError(error.message, error, this)
                    : new RequestError(String(error), {}, this);
            }
        }
        callback(error);
    }
    pipe(destination, options) {
        if (isPipedServerResponse(destination)) {
            this._pipedServerResponses.add(destination);
        }
        return super.pipe(destination, options);
    }
    unpipe(destination) {
        if (destination === undefined) {
            this._pipedServerResponses.clear();
        }
        else if (isPipedServerResponse(destination)) {
            this._pipedServerResponses.delete(destination);
        }
        super.unpipe(destination);
        return this;
    }
    // Got copied the status code and headers into every `ServerResponse` it is piped into, so it
    // owns the response and has to end it. A request that ends without one leaves the client
    // waiting forever.
    _closePipedServerResponses() {
        for (const destination of this._pipedServerResponses) {
            if (destination.writableEnded) {
                continue;
            }
            // An HTTP/2 stream destroyed without an error is reset with `NO_ERROR`, which the client
            // reads as a complete response, so the failure has to be in the reset code.
            if (destination instanceof external_node_http2_.Http2ServerResponse) {
                destination.stream.close(external_node_http2_.constants.NGHTTP2_INTERNAL_ERROR);
            }
            else {
                destination.destroy();
            }
        }
        this._pipedServerResponses.clear();
    }
    _attachAbortListener() {
        this._abortListenerDisposer?.[Symbol.dispose]();
        this._abortListenerDisposer = undefined;
        if (this.destroyed) {
            return;
        }
        const { signal } = this.options;
        if (!signal) {
            return;
        }
        const abort = () => {
            this._aborted = true;
            this._destroyInFlightAlpnSocket();
            // See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static#return_value
            if (signal.reason?.name === 'TimeoutError') {
                this.destroy(this._createTimeoutError(signal.reason));
            }
            else {
                this.destroy(new AbortError(this));
            }
        };
        if (signal.aborted) {
            abort();
        }
        else {
            this._abortListenerDisposer = (0,external_node_events_.addAbortListener)(signal, abort);
        }
    }
    _createTimeoutError(error) {
        return new TimeoutError(error, this.timings ?? createPreRequestErrorTimings(), this);
    }
    _destroyInFlightAlpnSocket() {
        this._requestOptions?._alpnSocket?.destroy();
    }
    _shouldIncrementallyDecodeBody() {
        const { responseType, encoding } = this.options;
        return Boolean(this._noPipe)
            && (responseType === 'text' || responseType === 'json')
            && isUtf8Encoding(encoding);
    }
    _checkContentLengthMismatch() {
        if (this.options.strictContentLength && this._expectedContentLength !== undefined) {
            // Use compressed bytes count when available (for compressed responses),
            // otherwise use _downloadedSize (for uncompressed responses)
            const actualSize = this._compressedBytesCount ?? this._downloadedSize;
            if (actualSize !== this._expectedContentLength) {
                this._beforeError(new ReadError({
                    message: `Content-Length mismatch: expected ${this._expectedContentLength} bytes, received ${actualSize} bytes`,
                    name: 'Error',
                    code: 'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
                }, this));
                return true;
            }
        }
        return false;
    }
    // A `beforeRequest` or `beforeRedirect` hook can assign a `FormData` body, and only this
    // place turns one into a stream, so it runs again once the hooks have had their say.
    _serializeFormDataBody(options, contentTypeChanged) {
        if (!(options.body instanceof FormData)) {
            return;
        }
        const headers = options.getInternalHeaders();
        const { body, contentType } = serializeNativeFormDataBody(options.body);
        // Every serialization picks a new boundary, so a header Got generated for an earlier one
        // no longer names it. Only a header the caller set itself survives.
        const contentTypeWasGenerated = !contentTypeChanged && (distribution.undefined(headers['content-type']) || this._nativeFormDataBody?.contentTypeWasGenerated === true);
        this._nativeFormDataBody = {
            form: options.body,
            body,
            contentTypeWasGenerated,
        };
        if (contentTypeWasGenerated) {
            headers['content-type'] = contentType;
        }
        options.body = body;
    }
    async _finalizeBody() {
        const { options } = this;
        const headers = options.getInternalHeaders();
        const isForm = !distribution.undefined(options.form);
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const isJSON = !distribution.undefined(options.json);
        const isBody = !distribution.undefined(options.body);
        const cannotHaveBody = !methodCanHaveBody(options);
        if (isForm || isJSON || isBody) {
            if (cannotHaveBody) {
                throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
            }
            // Serialize body
            const noContentType = distribution.undefined(headers['content-type']);
            if (isBody) {
                if (Object.prototype.toString.call(options.body) === '[object FormData]' && !(options.body instanceof FormData)) {
                    throw new TypeError('Non-native FormData is not supported. Use globalThis.FormData instead.');
                }
                this._serializeFormDataBody(options, false);
            }
            else if (isForm) {
                if (noContentType) {
                    headers['content-type'] = 'application/x-www-form-urlencoded';
                }
                const { form } = options;
                options.form = undefined;
                options.body = (new URLSearchParams(form)).toString();
            }
            else {
                if (noContentType) {
                    headers['content-type'] = 'application/json';
                }
                const { json } = options;
                options.json = undefined;
                options.body = options.stringifyJson(json);
            }
            const uploadBodySize = getBodySize(options.body, headers);
            // See https://tools.ietf.org/html/rfc7230#section-3.3.2
            // A user agent SHOULD send a Content-Length in a request message when
            // no Transfer-Encoding is sent and the request method defines a meaning
            // for an enclosed payload body.  For example, a Content-Length header
            // field is normally sent in a POST request even when the value is 0
            // (indicating an empty payload body).  A user agent SHOULD NOT send a
            // Content-Length header field when the request message does not contain
            // a payload body and the method semantics do not anticipate such a
            // body.
            if (distribution.undefined(headers['content-length']) && distribution.undefined(headers['transfer-encoding']) && !cannotHaveBody && !distribution.undefined(uploadBodySize)) {
                headers['content-length'] = String(uploadBodySize);
            }
        }
        if (options.responseType === 'json' && !('accept' in headers)) {
            headers.accept = 'application/json';
        }
        this._bodySize = parseContentLength(headers['content-length']);
    }
    async _onResponseBase(response) {
        // This will be called e.g. when using cache so we need to check if this request has been aborted.
        if (this.isAborted) {
            return;
        }
        const { options } = this;
        const { url } = options;
        const nativeResponse = response;
        const statusCode = response.statusCode;
        const { method } = options;
        const redirectLocationHeader = response.headers.location;
        const redirectLocation = Array.isArray(redirectLocationHeader) ? redirectLocationHeader[0] : redirectLocationHeader;
        const isRedirect = Boolean(redirectLocation && redirectCodes.has(statusCode));
        // Skip decompression for responses that must not have bodies per RFC 9110:
        // - HEAD responses (any status code)
        // - 1xx (Informational): 100, 101, 102, 103, etc.
        // - 204 (No Content)
        // - 205 (Reset Content)
        // - 304 (Not Modified)
        const hasNoBody = method === 'HEAD'
            || (statusCode >= 100 && statusCode < 200)
            || statusCode === 204
            || statusCode === 205
            || statusCode === 304;
        const prepareResponse = (response) => {
            if (!Object.hasOwn(response, 'headers')) {
                Object.defineProperty(response, 'headers', {
                    value: response.headers,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            response.statusMessage ||= external_node_http_.STATUS_CODES[statusCode]; // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- The status message can be empty.
            response.url = stripUrlAuth(options.url);
            response.requestUrl = this.requestUrl;
            response.redirectUrls = this.redirectUrls;
            response.request = this;
            response.isFromCache = nativeResponse.fromCache ?? false;
            response.ip = this.ip;
            response.retryCount = this.retryCount;
            response.ok = isResponseOk(response);
            return response;
        };
        let typedResponse = prepareResponse(response);
        // Redirect responses that will be followed are drained raw. Decompressing them can
        // turn an irrelevant redirect body into a client-side failure or decompression DoS.
        // prepareResponse already evaluated the redirect predicate.
        const shouldFollowRedirect = isRedirect && !typedResponse.ok;
        if (options.decompress && !hasNoBody && !shouldFollowRedirect) {
            response = decompressResponseBody(response);
            copyRedirectDecision(typedResponse, response);
            typedResponse = prepareResponse(response);
            // When strictContentLength is enabled, track the compressed bytes emitted by the native response.
            if (options.strictContentLength && response !== nativeResponse) {
                this._compressedBytesCount = 0;
                nativeResponse.on('data', (chunk) => {
                    this._compressedBytesCount += byteLength(chunk);
                });
            }
        }
        // `decompressResponse` wraps the response stream when it decompresses,
        // so `response !== nativeResponse` indicates decompression happened.
        const wasDecompressed = response !== nativeResponse;
        this._responseSize = parseContentLength(response.headers['content-length']);
        this.response = typedResponse;
        this._incrementalDecode = this._shouldIncrementallyDecodeBody() ? { decoder: new TextDecoder(), chunks: [] } : undefined;
        // Publish response start event. A subscriber gets a copy, so it cannot change the response.
        publishResponseStart({
            requestId: this._requestId,
            url: typedResponse.url,
            statusCode,
            headers: { ...response.headers },
            isFromCache: typedResponse.isFromCache,
        });
        response.once('error', (error) => {
            // Node synthesizes ECONNRESET for close-delimited responses after all body
            // bytes have been delivered. Only ignore that late synthetic error on the
            // native response. Wrapped decompression streams surface real checksum and
            // truncation failures after the underlying response has completed.
            if (!wasDecompressed
                && response.complete
                && this._responseSize === undefined
                && error.code === 'ECONNRESET') {
                return;
            }
            this._aborted = true;
            this._beforeError(new ReadError(error, this));
        });
        response.once('aborted', () => {
            // Without Content-Length, connection close is the intended EOF signal (RFC 9110 §8.6),
            // not a premature abort. For wrapped decompression streams, rely on the native
            // response completion state because the wrapper strips `content-length`.
            if (this._responseSize === undefined && nativeResponse.complete) {
                return;
            }
            this._aborted = true;
            // Check if there's a content-length mismatch to provide a more specific error
            if (!this._checkContentLengthMismatch()) {
                this._beforeError(createServerAbortedError(this));
            }
        });
        let canFinalizeResponse = false;
        const handleResponseEnd = () => {
            if (!canFinalizeResponse
                || !response.readableEnded) {
                return;
            }
            canFinalizeResponse = false;
            if (this._stopReading) {
                return;
            }
            // Validate content-length if it was provided
            // Per RFC 9112: "If the sender closes the connection before the indicated number
            // of octets are received, the recipient MUST consider the message to be incomplete"
            // The guards stay apart: merging them would skip this check whenever reading stopped.
            // eslint-disable-next-line unicorn/prefer-combined-guards
            if (this._checkContentLengthMismatch()) {
                return;
            }
            this._responseSize = this._downloadedSize;
            this.emit('downloadProgress', this.downloadProgress);
            // Publish response end event
            publishResponseEnd({
                requestId: this._requestId,
                url: typedResponse.url,
                statusCode,
                bodySize: this._downloadedSize,
                timings: this.timings,
            });
            this.push(null);
        };
        if (!shouldFollowRedirect) {
            // The request budget ends with the final response body.
            response.once('end', () => {
                clearTimeout(this._requestTimeout);
                /*
                A stream request is never destroyed once it ends, so its abort listener would
                outlive it and a shared signal firing later would destroy a finished request. The
                promise API disposes it when the request itself is destroyed, which must not
                happen before the `afterResponse` hooks have run.
                */
                if (!this._noPipe && this.writableFinished) {
                    this._abortListenerDisposer?.[Symbol.dispose]();
                    this._abortListenerDisposer = undefined;
                }
            });
            // `set-cookie` handling below awaits the cookie jar. A fast response can fully
            // end during that await, so we need to observe `end` early without completing
            // the outward stream until cookie handling has finished.
            response.once('end', handleResponseEnd);
        }
        const rawCookies = response.headers['set-cookie'];
        const responseRawBodyPromise = this._noPipe
            && distribution.object(options.cookieJar)
            && rawCookies !== undefined
            && !shouldFollowRedirect
            ? this._setRawBody(response)
            : undefined;
        if (distribution.object(options.cookieJar) && rawCookies) {
            try {
                // Apply fields in wire order so asynchronous stores cannot restore a replaced cookie.
                for (const rawCookie of rawCookies) {
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        await options.cookieJar.setCookie(rawCookie, url.toString());
                    }
                    catch (error) {
                        if (!options.ignoreInvalidCookies) {
                            throw error;
                        }
                    }
                }
            }
            catch (error) {
                if (responseRawBodyPromise) {
                    await responseRawBodyPromise;
                }
                this._beforeError(error);
                return;
            }
        }
        // The above is running a promise, therefore we need to check if this request has been aborted yet again.
        if (this.isAborted) {
            return;
        }
        if (shouldFollowRedirect) {
            // We're being redirected, we don't care about the response.
            // It'd be best to abort the request, but we can't because
            // we would have to sacrifice the TCP connection. We don't want that.
            response.resume();
            this._cancelTimeouts?.();
            this._unproxyEvents?.();
            if (this.redirectUrls.length >= options.maxRedirects) {
                this._beforeError(new MaxRedirectsError(this));
                return;
            }
            this._request = undefined;
            // Reset progress for the new request.
            this._downloadedSize = 0;
            this._uploadedSize = 0;
            const updatedOptions = new Options(undefined, undefined, this.options);
            try {
                // We need this in order to support UTF-8
                const redirectBuffer = external_node_buffer_.Buffer.from(redirectLocation, 'binary').toString();
                const redirectUrl = new URL(redirectBuffer, url);
                // A redirect without a fragment inherits the fragment of the original URL. See https://www.rfc-editor.org/rfc/rfc9110#section-10.2.2
                if (!redirectBuffer.includes('#')) {
                    const previousUrl = url;
                    redirectUrl.hash = previousUrl.hash === '' && previousUrl.href.endsWith('#') ? '#' : previousUrl.hash;
                }
                const currentUnixSocketPath = getUnixSocketPath(url);
                const redirectUnixSocketPath = getUnixSocketPath(redirectUrl);
                if ((redirectUrl.protocol === 'unix:' && redirectUnixSocketPath === undefined)
                    // Relative redirects on the same socket are fine, but a redirect must not switch to a different local socket.
                    || (redirectUnixSocketPath !== undefined && currentUnixSocketPath !== redirectUnixSocketPath)) {
                    this._beforeError(new RequestError('Cannot redirect to UNIX socket', {}, this));
                    return;
                }
                // Redirecting to a different site, clear sensitive data.
                // For UNIX sockets, different socket paths are also different origins.
                const isDifferentOrigin = redirectUrl.origin !== url.origin
                    || currentUnixSocketPath !== redirectUnixSocketPath;
                const serverRequestedGet = statusCode === 303 && updatedOptions.method !== 'GET' && updatedOptions.method !== 'HEAD';
                // Avoid forwarding a POST body to a different origin on historical 301/302 redirects.
                const crossOriginRequestedGet = isDifferentOrigin
                    && (statusCode === 301 || statusCode === 302)
                    && updatedOptions.method === 'POST';
                const canRewrite = statusCode !== 307 && statusCode !== 308;
                const userRequestedGet = updatedOptions.methodRewriting && canRewrite && updatedOptions.method !== 'HEAD';
                const shouldDropBody = serverRequestedGet || crossOriginRequestedGet || userRequestedGet;
                if (shouldDropBody) {
                    updatedOptions.method = 'GET';
                    this._dropBody(updatedOptions);
                }
                else if (isDifferentOrigin
                    && canRewrite
                    && updatedOptions.method !== 'QUERY'
                    && this._hasBodyForRedirect(updatedOptions)) {
                    this._dropBody(updatedOptions);
                }
                if (isDifferentOrigin) {
                    // On cross-origin redirects, strip sensitive headers and any credentials
                    // embedded in the redirect URL itself to prevent a malicious server from
                    // leaking them to a third party. 307/308 redirects preserve the method and replayable body per RFC; QUERY does the same on 301/302.
                    updatedOptions.h2session = undefined;
                    this._stripCrossOriginState(updatedOptions, redirectUrl);
                }
                else {
                    redirectUrl.username = updatedOptions.username;
                    redirectUrl.password = updatedOptions.password;
                }
                // Redirect URLs are resolved internally. Restore the user option before hooks run so hook mutations still honor it.
                const { allowAbsoluteUrls } = updatedOptions;
                try {
                    updatedOptions.allowAbsoluteUrls = true;
                    updatedOptions.url = redirectUrl;
                }
                finally {
                    updatedOptions.allowAbsoluteUrls = allowAbsoluteUrls;
                }
                this.redirectUrls.push(redirectUrl);
                const boundaryBeforeRedirectHooks = getUrlPrefixBoundary(updatedOptions);
                const bodyBeforeRedirectHooks = updatedOptions.body;
                const h2sessionBeforeRedirectHooks = updatedOptions.h2session;
                const preHookState = isDifferentOrigin
                    ? undefined
                    : {
                        ...snapshotCrossOriginState(updatedOptions),
                        url: new URL(updatedOptions.url),
                    };
                this._checkRequestTimeout();
                if (this._stopReading) {
                    return;
                }
                const changedState = await updatedOptions.trackStateMutations(async (changedState) => {
                    for (const hook of updatedOptions.hooks.beforeRedirect) {
                        // eslint-disable-next-line no-await-in-loop
                        await hook(updatedOptions, typedResponse);
                        this._checkRequestTimeout(updatedOptions);
                        if (this._stopReading) {
                            break;
                        }
                    }
                    return changedState;
                });
                if (this._stopReading) {
                    return;
                }
                if (hasUrlOrPrefixUrlBoundaryChanged(updatedOptions, updatedOptions.url, boundaryBeforeRedirectHooks)) {
                    assertUrlHasSameOriginAsPrefixUrlIfNeeded(updatedOptions, updatedOptions.url);
                }
                updatedOptions.clearUnchangedCookieHeader(preHookState, changedState);
                // If a beforeRedirect hook changed the URL to a different origin,
                // strip sensitive headers that were preserved for the original origin.
                // When isDifferentOrigin was already true, headers were already stripped above.
                if (!isDifferentOrigin) {
                    const state = preHookState;
                    const hookUrl = updatedOptions.url;
                    const hookChangedOrigin = !isSameOrigin(state.url, hookUrl);
                    if (hookChangedOrigin
                        && (statusCode === 301 || statusCode === 302)
                        && updatedOptions.method === 'POST') {
                        updatedOptions.method = 'GET';
                        this._dropBody(updatedOptions);
                    }
                    if (hookChangedOrigin) {
                        if (updatedOptions.h2session === h2sessionBeforeRedirectHooks) {
                            updatedOptions.h2session = undefined;
                        }
                        if (canRewrite
                            && updatedOptions.method !== 'QUERY'
                            && this._hasUnchangedBodyForRedirect(updatedOptions, state, changedState)) {
                            this._dropBody(updatedOptions);
                        }
                        this._stripUnchangedCrossOriginState(updatedOptions, hookUrl, {
                            ...state,
                            changedState,
                            preserveUsername: hasExplicitCredentialInUrlChange(changedState, hookUrl, 'username')
                                || isCrossOriginCredentialChanged(state.url, hookUrl, 'username'),
                            preservePassword: hasExplicitCredentialInUrlChange(changedState, hookUrl, 'password')
                                || isCrossOriginCredentialChanged(state.url, hookUrl, 'password'),
                        });
                    }
                }
                const nativeFormDataBody = this._nativeFormDataBody;
                const bodyUnchangedByHooks = updatedOptions.body === bodyBeforeRedirectHooks;
                const wasNonReplayable = isNonReplayableBody(bodyBeforeRedirectHooks);
                const bodyWasRemovedByHooks = changedState.has('body')
                    && !hasBodyOption(updatedOptions)
                    && this.options.body === bodyBeforeRedirectHooks
                    && (!bodyUnchangedByHooks || this._hasWrittenBody || this._hasWritableBody);
                if (bodyWasRemovedByHooks) {
                    this._dropBody(updatedOptions);
                }
                else if (!bodyUnchangedByHooks
                    && wasNonReplayable
                    && this.options.body === bodyBeforeRedirectHooks) {
                    // A hook replaced or removed the body, so dispose of the original non-replayable one.
                    this._destroyBody(bodyBeforeRedirectHooks);
                }
                // Any redirect that keeps the body must replay it, including same-origin 301/302 redirects that keep the method.
                if (this._hasBodyForRedirect(updatedOptions)) {
                    if (bodyUnchangedByHooks
                        && nativeFormDataBody !== undefined
                        && updatedOptions.body === nativeFormDataBody.body) {
                        this._reserializeFormDataBody(updatedOptions, changedState.has('content-type'));
                    }
                    else if (bodyUnchangedByHooks
                        && (wasNonReplayable || (distribution.undefined(updatedOptions.body) && (this._hasWrittenBody || this._hasWritableBody)))) {
                        // Body-preserving redirects must replay the body, so follow the HTTP spec and other clients by failing for unchanged non-replayable bodies. Hooks may supply a fresh body.
                        this._dropBody(updatedOptions);
                        this._beforeError(new RequestError('Cannot follow redirect with a non-replayable body', {}, this));
                        return;
                    }
                }
                // Hook-replaced bodies must update the inherited Content-Length unless the hook set one explicitly.
                if (!bodyUnchangedByHooks && !changedState.has('content-length') && !distribution.undefined(updatedOptions.body)) {
                    this._serializeFormDataBody(updatedOptions, changedState.has('content-type'));
                    this._refreshBodySize(updatedOptions);
                }
                this._assertMethodCanHaveBody(updatedOptions, changedState);
                // Publish redirect event
                publishRedirect({
                    requestId: this._requestId,
                    fromUrl: stripUrlAuth(url),
                    toUrl: stripUrlAuth(updatedOptions.url),
                    statusCode,
                });
                this.emit('redirect', updatedOptions, typedResponse);
                this.options = updatedOptions;
                await this._makeRequest();
            }
            catch (error) {
                this._beforeError(error);
                return;
            }
            return;
        }
        // `HTTPError`s always have `error.response.body` defined.
        // Therefore, we cannot retry if `options.throwHttpErrors` is false.
        // On the last retry, if `options.throwHttpErrors` is false, we would need to return the body,
        // but that wouldn't be possible since the body would be already read in `error.response.body`.
        if (options.isStream && options.throwHttpErrors && !isResponseOk(typedResponse)) {
            this._beforeError(new HTTPError(typedResponse));
            return;
        }
        // Store the expected content-length from the native response for validation.
        // This is the content-length before decompression, which is what actually gets transferred.
        // Skip storing for responses that shouldn't have bodies per RFC 9110.
        // When decompression occurs, only store if strictContentLength is enabled.
        if (!hasNoBody && (!wasDecompressed || options.strictContentLength)) {
            const expectedLength = parseContentLength(nativeResponse.headers['content-length']);
            if (expectedLength !== undefined && expectedLength >= 0) {
                this._expectedContentLength = expectedLength;
            }
        }
        this.emit('downloadProgress', this.downloadProgress);
        response.on('readable', () => {
            if (this._triggerRead) {
                this._read();
            }
        });
        this.on('resume', () => {
            response.resume();
        });
        this.on('pause', () => {
            response.pause();
        });
        if (this._noPipe) {
            const captureFromResponse = response.readableEnded || responseRawBodyPromise !== undefined;
            if (!captureFromResponse) {
                canFinalizeResponse = true;
                handleResponseEnd();
            }
            const success = responseRawBodyPromise
                ? await responseRawBodyPromise
                : await this._setRawBody(captureFromResponse ? response : this);
            if (captureFromResponse) {
                canFinalizeResponse = true;
                handleResponseEnd();
            }
            if (success) {
                this.emit('response', response);
            }
            return;
        }
        this.emit('response', response);
        const connectionListedHeaders = getConnectionListedHeaders(response.headers);
        for (const destination of this._pipedServerResponses) {
            if (destination.headersSent) {
                continue;
            }
            for (const key in response.headers) {
                if (!Object.hasOwn(response.headers, key)) {
                    continue;
                }
                // When decompression occurred, skip content-encoding and content-length
                // as they refer to the compressed data, not the decompressed stream.
                // Hop-by-hop headers apply to the upstream connection only, so an intermediary must
                // not forward them either.
                // The guards stay apart: the one above filters to own properties, this one decides
                // which of them may be forwarded.
                // eslint-disable-next-line unicorn/prefer-combined-guards
                if ((wasDecompressed && (key === 'content-encoding' || key === 'content-length')) || hopByHopHeaders.has(key) || connectionListedHeaders.has(key)) {
                    continue;
                }
                const value = response.headers[key];
                // Skip if value is undefined
                if (value !== undefined) {
                    destination.setHeader(key, value);
                }
            }
            destination.statusCode = statusCode;
        }
        if (this._triggerRead) {
            this._read();
        }
        canFinalizeResponse = true;
        handleResponseEnd();
    }
    async _setRawBody(from = this) {
        try {
            // Errors are emitted via the `error` event
            const fromArray = await from.toArray();
            const hasNonStringChunk = fromArray.some(chunk => typeof chunk !== 'string');
            const rawBody = hasNonStringChunk
                ? concatUint8Arrays(fromArray.map(chunk => typeof chunk === 'string' ? external_node_buffer_.Buffer.from(chunk, from.readableEncoding ?? undefined) : chunk))
                : new Uint8Array(external_node_buffer_.Buffer.from(fromArray.join(''), from.readableEncoding ?? undefined));
            const shouldUseIncrementalDecodedBody = from === this && this._incrementalDecode !== undefined;
            // On retry Request is destroyed with no error, therefore the above will successfully resolve.
            // So in order to check if this was really successful, we need to check if it has been properly ended.
            if (!this.isAborted && this.response) {
                this.response.rawBody = rawBody;
                if (from !== this) {
                    this._downloadedSize = rawBody.byteLength;
                }
                if (shouldUseIncrementalDecodedBody) {
                    try {
                        const { decoder, chunks } = this._incrementalDecode;
                        const finalDecodedChunk = decoder.decode();
                        if (finalDecodedChunk.length > 0) {
                            chunks.push(finalDecodedChunk);
                        }
                        cacheDecodedBody(this.response, chunks.join(''));
                    }
                    catch { }
                }
                return true;
            }
        }
        catch { }
        finally {
            this._incrementalDecode = undefined;
        }
        return false;
    }
    async _onResponse(response) {
        try {
            await this._onResponseBase(response);
        }
        catch (error) {
            /* istanbul ignore next: better safe than sorry */
            this._beforeError(error);
        }
    }
    _onRequest(request, useCache) {
        const { options } = this;
        const { timeout, url } = options;
        // Publish request start event. A subscriber gets a copy, so it cannot change the request.
        publishRequestStart({
            requestId: this._requestId,
            url: getSanitizedUrl(this.options),
            method: options.method,
            headers: { ...options.headers },
        });
        utils_timer(request);
        // `timeout.socket` is the inactivity timeout. The HTTP/2 request maps it onto the
        // stream, so a stalled response body still times out.
        this._cancelTimeouts = timedOut(request, timeout, url);
        let lastRequestError;
        const responseEventName = useCache ? 'cacheableResponse' : 'response';
        request.once(responseEventName, (response) => {
            void this._onResponse(response);
        });
        const emitRequestError = (error) => {
            this._aborted = true;
            // Force clean-up, because some packages (e.g. nock) don't do this.
            request.destroy();
            const wrappedError = error instanceof timed_out_TimeoutError ? this._createTimeoutError(error) : new RequestError(error.message, error, this);
            this._beforeError(wrappedError);
        };
        request.once('error', (error) => {
            lastRequestError = error;
            // Ignore errors from requests superseded by a redirect.
            if (this._request !== request) {
                return;
            }
            /*
            Transient write errors (EPIPE, ECONNRESET) often fire during redirects when the
            server closes the connection after sending the redirect response. Defer by one
            microtask to let the response event make the request stale.
            */
            if (isTransientWriteError(error)) {
                queueMicrotask(() => {
                    /*
                    `request.writableEnded` and `request.destroyed` are not checked here: a
                    request whose body finished writing still fails when the connection resets
                    before the response, so a response-less reset is the real failure and not a
                    superseded request. A response that already arrived makes it stale.
                    */
                    if (this._request !== request || hasResponse(request)) {
                        return;
                    }
                    emitRequestError(error);
                });
                return;
            }
            emitRequestError(error);
        });
        if (!useCache) {
            request.once('close', () => {
                if (this._request !== request || hasResponse(request) || this._stopReading) {
                    return;
                }
                this._beforeError(lastRequestError ?? createServerAbortedError(this));
            });
        }
        this._unproxyEvents = proxyEvents(request, this, proxiedRequestEvents);
        this._request = request;
        this._bodySize = parseContentLength(options.headers['content-length']);
        this.emit('uploadProgress', this.uploadProgress);
        this._sendBody();
        this.emit('request', request);
    }
    _isRequestStale(request) {
        return this._request !== request || hasResponse(request) || request.destroyed || request.writableEnded;
    }
    _cancelActiveWebBodyReader(body) {
        const activeReader = this._activeWebBodyReader;
        if (activeReader?.body !== body) {
            return false;
        }
        this._activeWebBodyReader = undefined;
        try {
            void activeReader.reader.cancel().catch(core_noop);
        }
        catch { }
        finally {
            activeReader.reader.releaseLock();
        }
        return true;
    }
    async *_iterateWebBody(body) {
        const reader = body.getReader();
        this._activeWebBodyReader = { body, reader };
        try {
            while (true) {
                // eslint-disable-next-line no-await-in-loop
                const { done, value } = await reader.read();
                if (done) {
                    return;
                }
                yield value;
            }
        }
        finally {
            this._cancelActiveWebBodyReader(body);
        }
    }
    async *_iterateBody(body) {
        // Keep source errors separate from socket write failures, which may be retried.
        try {
            yield* body instanceof ReadableStream ? this._iterateWebBody(body) : body;
        }
        catch (error) {
            throw new UploadError(normalizeError(error), this);
        }
    }
    async _asyncWrite(chunk, request = this) {
        return new Promise((resolve, reject) => {
            if (request === this) {
                super.write(chunk, error => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
                return;
            }
            this._writeRequest(chunk, undefined, error => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            }, request);
        });
    }
    _sendBody() {
        // Send body
        const { body } = this.options;
        this._dispatchedBody = { body };
        // From here on, every write routed through `_write` is Got's own body dispatch, so a
        // read-only stream no longer needs to refuse it.
        this._dispatchingOwnBody = true;
        const currentRequest = this.redirectUrls.length === 0 && !this._discardBodyWrites ? this : this._request ?? this;
        if (distribution.nodeStream(body) && currentRequest === this) {
            // Hooks and handlers can replace the body after the constructor registered its listener.
            body.off('error', this._onBodyError).once('error', this._onBodyError);
            body.pipe(currentRequest);
        }
        else if (distribution.buffer(body)) {
            // Buffer should be sent directly without conversion
            this._writeBodyInChunks(body, currentRequest);
        }
        else if (ArrayBuffer.isView(body)) {
            // ArrayBuffer views should be treated like buffers, not iterated over
            // Create a Uint8Array view over the data (Node.js streams accept Uint8Array)
            const uint8View = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
            this._writeBodyInChunks(uint8View, currentRequest);
        }
        else if (isIterableBody(body)) {
            (async () => {
                const isInitialRequest = currentRequest === this;
                const bodyOptions = this.options;
                const isBodySuperseded = () => this.options !== bodyOptions || this.options.body !== body;
                try {
                    for await (const chunk of this._iterateBody(body)) {
                        if (isBodySuperseded()) {
                            return;
                        }
                        await this._asyncWrite(chunk, currentRequest);
                        if (isBodySuperseded()) {
                            return;
                        }
                    }
                    if (!isBodySuperseded()) {
                        if (isInitialRequest) {
                            super.end();
                            return;
                        }
                        await this._endWritableRequest(currentRequest);
                    }
                }
                catch (error) {
                    if (isBodySuperseded()) {
                        return;
                    }
                    this._beforeError(error);
                }
            })();
        }
        else if (distribution.undefined(body)) {
            // No body to send, end the request
            if (currentRequest !== this) {
                void (async () => {
                    try {
                        await this._endWritableRequest(currentRequest);
                    }
                    catch (error) {
                        this._beforeError(error);
                    }
                })();
            }
            else if ((this._noPipe ?? false) || !this._methodCanHaveBody) {
                currentRequest.end();
            }
        }
        else {
            // Handles string bodies (from json/form options).
            this._writeBodyInChunks(stringToUint8Array(body), currentRequest);
        }
    }
    /*
    Write a body buffer in chunks to enable granular `uploadProgress` events.

    Without chunking, string/Uint8Array/TypedArray bodies are written in a single call, causing `uploadProgress` to only emit 0% and 100% with nothing in between.

    The 64 KB chunk size matches Node.js fs stream defaults.
    */
    _writeBodyInChunks(buffer, currentRequest) {
        const isInitialRequest = currentRequest === this;
        (async () => {
            let request;
            try {
                request = isInitialRequest ? this._request : currentRequest;
                const activeRequest = request;
                if (!activeRequest) {
                    if (isInitialRequest) {
                        super.end();
                    }
                    return;
                }
                if (activeRequest.destroyed) {
                    return;
                }
                await this._writeChunksToRequest(buffer, activeRequest);
                if (this._isRequestStale(activeRequest)) {
                    this._finalizeStaleChunkedWrite(activeRequest, isInitialRequest);
                    return;
                }
                if (isInitialRequest) {
                    super.end();
                    return;
                }
                await this._endWritableRequest(activeRequest);
            }
            catch (error) {
                const normalizedError = normalizeError(error);
                // Transient write errors (EPIPE, ECONNRESET) are handled by the request-level
                // error and close handlers. For initial redirected writes, still finalize
                // writable state once the stale transition becomes observable.
                if (isTransientWriteError(normalizedError)) {
                    if (isInitialRequest && request) {
                        const initialRequest = request;
                        let didFinalize = false;
                        const finalizeIfStale = () => {
                            if (didFinalize || !this._isRequestStale(initialRequest)) {
                                return;
                            }
                            didFinalize = true;
                            this._finalizeStaleChunkedWrite(initialRequest, true);
                        };
                        finalizeIfStale();
                        if (!didFinalize) {
                            initialRequest.once('response', finalizeIfStale);
                            queueMicrotask(finalizeIfStale);
                        }
                    }
                    return;
                }
                if (!isInitialRequest && this._isRequestStale(currentRequest)) {
                    return;
                }
                this._beforeError(normalizedError);
            }
        })();
    }
    _finalizeStaleChunkedWrite(request, isInitialRequest) {
        if (!request.destroyed && !request.writableEnded) {
            request.destroy();
        }
        if (isInitialRequest) {
            // Finalize writable state without ending the active redirected request.
            this._skipRequestEndInFinal = true;
            super.end();
        }
    }
    _emitUploadComplete(request) {
        this._bodySize = this._uploadedSize;
        this.emit('uploadProgress', this.uploadProgress);
        request.emit('upload-complete');
    }
    async _endWritableRequest(request) {
        await new Promise((resolve, reject) => {
            request.end((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (this._request === request && !request.destroyed) {
                    this._emitUploadComplete(request);
                }
                resolve();
            });
        });
    }
    _stripCrossOriginState(options, urlToClear) {
        for (const header of crossOriginStripHeaders) {
            options.deleteInternalHeader(header);
        }
        options.username = '';
        options.password = '';
        urlToClear.username = '';
        urlToClear.password = '';
    }
    _stripUnchangedCrossOriginState(options, urlToClear, state) {
        const headers = options.getInternalHeaders();
        for (const header of crossOriginStripHeaders) {
            if (!state.changedState.has(header) && headers[header] === state.headers[header]) {
                options.deleteInternalHeader(header);
            }
        }
        if (!state.preserveUsername) {
            options.username = '';
            urlToClear.username = '';
        }
        if (!state.preservePassword) {
            options.password = '';
            urlToClear.password = '';
        }
    }
    get _methodCanHaveBody() {
        return methodCanHaveBody(this.options);
    }
    _canWriteBody() {
        return !this._noPipe && !this.isReadonly && this._methodCanHaveBody;
    }
    _hasBodyForRedirect(options) {
        return hasBodyOption(options) || this._hasWrittenBody || this._hasWritableBody;
    }
    _hasUnchangedBodyForRedirect(options, state, changedState) {
        return !hasBodyOptionChanged(changedState)
            && this._hasBodyForRedirect(options)
            && isBodyUnchanged(options, state);
    }
    // A hook that switched to a method that cannot carry a body must drop or replace the body,
    // the same way the initial request preparation requires.
    _assertMethodCanHaveBody(options, changedState) {
        if (changedState.has('method') && !distribution.undefined(options.body) && !methodCanHaveBody(options)) {
            throw new TypeError(`The \`${options.method}\` method cannot be used with a body`);
        }
    }
    _refreshBodySize(options) {
        const bodySize = distribution.undefined(options.body) || !distribution.undefined(options.getInternalHeaders()['transfer-encoding']) ? undefined : getBodySize(options.body, undefined);
        if (bodySize === undefined) {
            options.deleteInternalHeader('content-length');
        }
        else {
            options.setInternalHeader('content-length', String(bodySize));
        }
        this._bodySize = bodySize;
    }
    _dropBody(updatedOptions) {
        const { body } = this.options;
        const updatedBody = updatedOptions.body;
        const hadOptionBody = hasBodyOption(this.options);
        this.options.clearBody();
        this._destroyBody(body);
        if (updatedBody !== body) {
            this._destroyBody(updatedBody);
        }
        if (!hadOptionBody && !this.writableEnded) {
            this._skipRequestEndInFinal = true;
            super.end();
        }
        updatedOptions.clearBody();
        this._bodySize = undefined;
        this._hasWrittenBody = false;
        this._hasWritableBody = false;
    }
    _reserializeFormDataBody(options, contentTypeChanged) {
        const nativeFormDataBody = this._nativeFormDataBody;
        // Native FormData generates a fresh stream and boundary, so re-serialize it to replay the upload.
        this._destroyBody(options.body);
        const { body, contentType } = serializeNativeFormDataBody(nativeFormDataBody.form);
        nativeFormDataBody.body = body;
        options.body = body;
        if (contentTypeChanged) {
            nativeFormDataBody.contentTypeWasGenerated = false;
        }
        else if (nativeFormDataBody.contentTypeWasGenerated) {
            options.setInternalHeader('content-type', contentType);
        }
    }
    _destroyBody(body) {
        if (distribution.nodeStream(body)) {
            const bodyStream = body;
            bodyStream.off('error', this._onBodyError);
            bodyStream.unpipe();
            bodyStream.on('error', core_noop);
            bodyStream.destroy();
        }
        else if (body instanceof ReadableStream) {
            if (!this._cancelActiveWebBodyReader(body) && !body.locked) {
                void body.cancel().catch(core_noop);
            }
        }
        else if (isIterableBody(body)) {
            const iterableBody = body;
            // Signal the iterator to clean up, but don't await it:
            // the for-await loop in _sendBody exits via the options.body sentinel,
            // and awaiting return() would deadlock when next() is pending.
            if (typeof iterableBody.return === 'function') {
                try {
                    const result = iterableBody.return();
                    if (result instanceof Promise) {
                        result.catch(core_noop);
                    }
                }
                catch { }
            }
        }
    }
    _onBodyError = (error) => {
        if (this._flushed) {
            this._beforeError(new UploadError(error, this));
        }
        else {
            this.flush = async () => {
                this.flush = async () => { };
                this._beforeError(new UploadError(error, this));
            };
        }
    };
    async _writeChunksToRequest(buffer, request) {
        const chunkSize = 65_536; // 64 KB
        const isStale = () => this._isRequestStale(request);
        for (const part of chunk(buffer, chunkSize)) {
            if (isStale()) {
                return;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve, reject) => {
                this._writeRequest(part, undefined, error => {
                    if (isStale()) {
                        resolve();
                        return;
                    }
                    if (error) {
                        reject(error);
                    }
                    else {
                        setImmediate(resolve);
                    }
                }, request);
            });
        }
    }
    _prepareCache(cache) {
        if (cacheableStore.has(cache)) {
            return;
        }
        const cacheableRequest = new dist(((requestOptions, handler) => {
            const gotRequest = requestOptions.gotRequest;
            if (gotRequest?._stopReading) {
                throw new AbortError(gotRequest);
            }
            /**
            Wraps the cacheable-request handler to run beforeCache hooks.
            These hooks control caching behavior by:
            - Directly mutating the response object (changes apply to what gets cached)
            - Returning `false` to prevent caching
            - Returning `void`/`undefined` to use default caching behavior

            Hooks use direct mutation - they can modify response.headers, response.statusCode, etc.
            Mutations take effect immediately and determine what gets cached.
            */
            const wrappedHandler = handler
                ? (response) => {
                    const { beforeCacheHooks, gotRequest } = requestOptions;
                    // Early return if no hooks - cache the original response
                    if (!beforeCacheHooks || beforeCacheHooks.length === 0) {
                        handler(response);
                        return;
                    }
                    // The hooks change the caching layer's view of the headers, not the response the
                    // caller receives. The cache policy keeps a reference to whatever `headers` holds
                    // when it is built, so a copy is swapped in and swapped back afterwards. The copy
                    // must own the array values too, or a hook pushing to `set-cookie` would edit the
                    // caller's list. Unlike headers, a status mutation is shared with the caller on
                    // purpose: the live response streams carry it.
                    const callerHeaders = response.headers;
                    response.headers = Object.fromEntries(Object.entries(callerHeaders).map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]));
                    try {
                        try {
                            // Call each beforeCache hook with the response
                            // Hooks can directly mutate the response - mutations take effect immediately
                            for (const hook of beforeCacheHooks) {
                                const result = hook(response);
                                if (result === false) {
                                    // Prevent caching by adding no-cache headers
                                    // Mutate the response directly to add headers
                                    response.headers['cache-control'] = 'no-cache, no-store, must-revalidate';
                                    response.headers.pragma = 'no-cache';
                                    response.headers.expires = '0';
                                    handler(response);
                                    // Don't call remaining hooks - we've decided not to cache
                                    return;
                                }
                                if (distribution.promise(result)) {
                                    // BeforeCache hooks must be synchronous because cacheable-request's handler is synchronous
                                    throw new TypeError('beforeCache hooks must be synchronous. The hook returned a Promise, but this hook must return synchronously. If you need async logic, use beforeRequest hook instead.');
                                }
                                if (result !== undefined) {
                                    // Hooks should return false or undefined only
                                    // Mutations work directly - no need to return the response
                                    throw new TypeError('beforeCache hook must return false or undefined. To modify the response, mutate it directly.');
                                }
                                // Else: void/undefined = continue
                            }
                        }
                        catch (error) {
                            // Convert hook errors to RequestError and propagate
                            // This is consistent with how other hooks handle errors
                            if (gotRequest) {
                                gotRequest._beforeError(error);
                                // Don't call handler when error was propagated successfully
                                return;
                            }
                            // If gotRequest is missing, log the error to aid debugging
                            // We still call the handler to prevent the request from hanging
                            console.error('Got: beforeCache hook error (request context unavailable):', error);
                            // Call handler with response (potentially partially modified)
                            handler(response);
                            return;
                        }
                        // All hooks ran successfully
                        // Cache the response with any mutations applied
                        handler(response);
                    }
                    finally {
                        // The caller's response keeps the server's headers, whatever the hooks or
                        // the cache layer did with the copy.
                        response.headers = callerHeaders;
                    }
                }
                : handler;
            const result = requestOptions._request(requestOptions, wrappedHandler);
            // TODO: remove this when `cacheable-request` supports async request functions.
            if (distribution.promise(result)) {
                // We only need to implement the error handler in order to support HTTP/2 caching.
                // The result will be a promise anyway.
                // @ts-expect-error ignore
                result.once = (event, handler) => {
                    if (event === 'error') {
                        (async () => {
                            try {
                                await result;
                            }
                            catch (error) {
                                handler(error);
                            }
                        })();
                    }
                    else if (event === 'abort' || event === 'destroy') {
                        // The empty catch is needed here in case when
                        // it rejects before it's `await`ed in `_makeRequest`.
                        (async () => {
                            try {
                                const request = (await result);
                                request.once(event, handler);
                            }
                            catch { }
                        })();
                    }
                    else {
                        /* istanbul ignore next: safety check */
                        throw new Error(`Unknown HTTP/2 promise event: ${event}`);
                    }
                    return result;
                };
            }
            return result;
        }), cache);
        cacheableStore.set(cache, cacheableRequest.request());
    }
    async _createCacheableRequest(url, options) {
        return new Promise((resolve, reject) => {
            const hostname = distribution.string(url.hostname) && url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
            Object.assign(options, {
                protocol: url.protocol,
                hostname,
                host: hostname,
                hash: url.hash === '' ? '' : (url.hash ?? null),
                search: url.search === '' ? '' : (url.search ?? null),
                pathname: url.pathname,
                href: url.href,
                path: `${url.pathname || ''}${url.search || ''}`,
                ...(distribution.string(url.port) && url.port.length > 0 && { port: Number(url.port) }),
                // The `&&` form spreads an empty credential as `{0: ''}`, so the absent case stays
                // explicit. A URL such as `http://@example.com` has both parts set to `''`.
                // eslint-disable-next-line unicorn/consistent-conditional-object-spread
                ...(url.username || url.password ? { auth: `${url.username || ''}:${url.password || ''}` } : {}),
            });
            let request;
            // TODO: Fix `cacheable-response`. This is ugly.
            const cacheRequest = cacheableStore.get(options.cache)(options, (response) => {
                void (async () => {
                    response._readableState.autoDestroy = false;
                    if (request) {
                        const fix = () => {
                            // For ResponseLike objects from cache, set complete to true if not already set.
                            // For real HTTP responses, copy from the underlying response.
                            if (response.req) {
                                response.complete = response.req.res.complete;
                            }
                            else if (response.complete === undefined) {
                                // ResponseLike from cache should have complete = true
                                response.complete = true;
                            }
                        };
                        response.prependOnceListener('end', fix);
                        fix();
                        (await request).emit('cacheableResponse', response);
                    }
                    resolve(response);
                })();
            });
            cacheRequest.once('error', reject);
            cacheRequest.once('request', (requestOrPromise) => {
                request = requestOrPromise;
                resolve(request);
            });
        });
    }
    // `timeout.request` is a global budget: one timer covers the whole request, including redirects and the hooks between them.
    // Redirect and hook boundaries call this again so time spent in hooks counts and changes hooks make to `timeout.request` take effect.
    // The budget is read from the options the hook mutated, which is not `this.options` until the hooks are done.
    _checkRequestTimeout(options = this.options) {
        clearTimeout(this._requestTimeout);
        const budget = options.timeout.request;
        if (budget === undefined || this._startedAt === undefined || this._stopReading) {
            return;
        }
        const remaining = budget - (Date.now() - this._startedAt);
        if (remaining <= 0) {
            this._expireRequestTimeout(budget);
            return;
        }
        // Node turns overflowing timer delays into 1 ms, so an unarmable budget means no timeout.
        if (!isArmableTimerDelay(remaining)) {
            return;
        }
        this._requestTimeout = setTimeout(() => {
            // A hook may have changed the budget while the timer was pending, so only an unchanged budget expires here.
            if (this.options.timeout.request === budget) {
                this._expireRequestTimeout(budget);
            }
            else {
                this._checkRequestTimeout();
            }
        }, remaining);
        this._requestTimeout.unref();
    }
    _expireRequestTimeout(budget) {
        const error = new timed_out_TimeoutError(budget, 'request');
        // An in-flight native request reports the error through its own error handler, which tears down the socket and records the timings.
        if (this._request && !this._request.destroyed) {
            this._request.destroy(error);
        }
        else {
            this._beforeError(error);
        }
    }
    async _makeRequest() {
        const { options } = this;
        this._attachAbortListener();
        if (this.redirectUrls.length > 0) {
            this._checkRequestTimeout();
        }
        if (this.destroyed || this._stopReading) {
            return;
        }
        const shouldDeleteGeneratedHeader = (currentHeader, generatedHeader) => currentHeader === generatedHeader || distribution.undefined(currentHeader);
        const syncGeneratedHeader = (name, { currentHeader, explicitHeader, nextHeader, staleGeneratedHeader, }) => {
            if (!distribution.undefined(nextHeader)) {
                options.setInternalHeader(name, nextHeader);
            }
            else if (!distribution.undefined(explicitHeader) && currentHeader === staleGeneratedHeader) {
                options.setInternalHeader(name, explicitHeader);
            }
            else if (shouldDeleteGeneratedHeader(currentHeader, staleGeneratedHeader)) {
                options.deleteInternalHeader(name);
            }
        };
        const getAuthorizationHeader = (username, password, isExplicitlyOmitted) => !isExplicitlyOmitted && (username || password)
            ? `Basic ${stringToBase64(`${username}:${password}`)}`
            : undefined;
        const sanitizeHeaders = () => {
            const currentHeaders = options.getInternalHeaders();
            for (const key in currentHeaders) {
                if (distribution.undefined(currentHeaders[key])) {
                    options.deleteInternalHeader(key);
                }
                else if (distribution.null(currentHeaders[key])) {
                    throw new TypeError(`Use \`undefined\` instead of \`null\` to delete the \`${key}\` header`);
                }
                else if (Array.isArray(currentHeaders[key]) && (key === 'transfer-encoding' || singleValueRequestHeaders.has(key))) {
                    // Node serializes request header arrays as repeated field lines, so keep framing
                    // unambiguous, and duplicate credential and content-length lines are not allowed on
                    // requests. Normalize a single-element array to match the long-supported string path.
                    if (currentHeaders[key].length !== 1) {
                        throw new TypeError(`The \`${key}\` header must be a single value`);
                    }
                    options.setInternalHeader(key, currentHeaders[key][0]);
                }
            }
            return currentHeaders;
        };
        const getCookieHeader = async (cookieJar) => {
            if (!cookieJar) {
                return undefined;
            }
            const cookieString = await cookieJar.getCookieString(options.url.toString());
            return distribution.nonEmptyString(cookieString) ? cookieString : undefined;
        };
        if (options.cookieJar && !options.isHeaderExplicitlySet('cookie')) {
            options.deleteInternalHeader('cookie');
        }
        const headers = sanitizeHeaders();
        const initialHeaders = options.getInternalHeaders();
        const authorizationWasInitiallyExplicit = options.isHeaderExplicitlySet('authorization');
        const explicitAuthorizationHeader = authorizationWasInitiallyExplicit ? initialHeaders.authorization : undefined;
        const explicitCookieHeader = options.isHeaderExplicitlySet('cookie') ? initialHeaders.cookie : undefined;
        const authorizationWasInitiallyOmitted = authorizationWasInitiallyExplicit && distribution.undefined(initialHeaders.authorization);
        const cookieWasInitiallyOmitted = options.isHeaderExplicitlySet('cookie') && distribution.undefined(initialHeaders.cookie);
        if (options.decompress && distribution.undefined(headers['accept-encoding']) && !options.isHeaderExplicitlySet('accept-encoding')) {
            const encodings = supportsBrotli ? ['gzip', 'deflate', 'br'] : ['gzip', 'deflate'];
            if (core_supportsZstd) {
                encodings.push('zstd');
            }
            options.setInternalHeader('accept-encoding', encodings.join(', '));
        }
        const { username, password } = options;
        const cookieJar = options.cookieJar;
        // Preserve an explicit Authorization header over URL-derived Basic auth. This keeps
        // normalized single-element arrays aligned with the long-supported string behavior.
        const generatedAuthorizationHeader = distribution.undefined(explicitAuthorizationHeader)
            ? getAuthorizationHeader(username, password, authorizationWasInitiallyOmitted)
            : undefined;
        let generatedCookieHeader;
        if (!distribution.undefined(generatedAuthorizationHeader)) {
            options.setInternalHeader('authorization', generatedAuthorizationHeader);
        }
        if (!cookieWasInitiallyOmitted) {
            generatedCookieHeader = await getCookieHeader(cookieJar);
            this._checkRequestTimeout();
            if (this._stopReading) {
                return;
            }
            if (!distribution.undefined(generatedCookieHeader)) {
                options.setInternalHeader('cookie', generatedCookieHeader);
            }
        }
        let request;
        const urlBeforeRequestHooks = options.url instanceof URL ? new URL(options.url) : undefined;
        const boundaryBeforeRequestHooks = getUrlPrefixBoundary(options);
        const stateBeforeRequestHooks = urlBeforeRequestHooks ? snapshotCrossOriginState(options) : undefined;
        const crossOriginHookStrippedHeaders = new Set();
        const changedState = await options.trackStateMutations(async (changedState) => {
            for (const hook of options.hooks.beforeRequest) {
                // eslint-disable-next-line no-await-in-loop
                const result = await hook(options, { retryCount: this.retryCount });
                this._checkRequestTimeout();
                if (this._stopReading) {
                    // The request timed out or was aborted while the hook was pending.
                    destroyRequestResult(result);
                    break;
                }
                if (!distribution.undefined(result)) {
                    // @ts-expect-error Skip the type mismatch to support abstract responses
                    request = () => result;
                    break;
                }
            }
            return changedState;
        });
        this._attachAbortListener();
        if (this.destroyed) {
            return;
        }
        let shouldOmitRequestUrlCredentials = false;
        // A hook that replaced the body must refresh the inherited `content-length`, or the
        // declared length belongs to the previous body and the extra bytes stay on the
        // connection. The sibling retry and redirect hooks do the same, and additionally tear
        // down the body they replaced, which this path has no use for: the hook is done with
        // it and the caller still owns it.
        if (changedState.has('body') && !changedState.has('content-length')) {
            this._serializeFormDataBody(options, changedState.has('content-type'));
            this._refreshBodySize(options);
        }
        this._assertMethodCanHaveBody(options, changedState);
        if (urlBeforeRequestHooks
            && options.url instanceof URL
            && hasUrlOrPrefixUrlBoundaryChanged(options, options.url, boundaryBeforeRequestHooks)) {
            assertUrlHasSameOriginAsPrefixUrlIfNeeded(options, options.url);
        }
        if (urlBeforeRequestHooks
            && options.url instanceof URL
            && !isSameOrigin(urlBeforeRequestHooks, options.url)) {
            const hookChangedState = new Set(changedState);
            const currentHeaders = options.getInternalHeaders();
            const changedHeaders = {};
            for (const header of crossOriginStripHeaders) {
                if (hookChangedState.has(header)) {
                    changedHeaders[header] = currentHeaders[header];
                }
                else {
                    options.deleteInternalHeader(header);
                    crossOriginHookStrippedHeaders.add(header);
                }
            }
            const changedOptions = {
                headers: changedHeaders,
                ...(hookChangedState.has('url') && { url: options.url }),
                ...(hookChangedState.has('prefixUrl') && { prefixUrl: options.prefixUrl }),
                ...(hookChangedState.has('username') && { username: options.username }),
                ...(hookChangedState.has('password') && { password: options.password }),
            };
            options.stripSensitiveHeaders(urlBeforeRequestHooks, options.url, changedOptions);
            this._discardBodyWrites = true;
            this._hasWrittenBody = false;
            this._hasWritableBody = false;
            if (!hasBodyOptionChanged(hookChangedState)
                && isBodyUnchanged(options, stateBeforeRequestHooks)) {
                options.clearBody();
                this._bodySize = undefined;
            }
        }
        if (request === undefined) {
            const currentHeaders = options.getInternalHeaders();
            // `headers.authorization = undefined` / `headers.cookie = undefined` is an
            // explicit opt-out. Respect that instead of regenerating values from URL
            // credentials or the cookie jar later in request setup.
            const isHeaderExplicitlyOmitted = (header) => options.isHeaderExplicitlySet(header)
                && (Object.hasOwn(currentHeaders, header) || changedState.has(header))
                && distribution.undefined(currentHeaders[header]);
            const currentAuthorizationHeader = currentHeaders.authorization;
            const currentCookieHeader = currentHeaders.cookie;
            // Authorization follows a small contract:
            // - A concrete Authorization header is sent as-is.
            // - `authorization = undefined` means omit Authorization entirely, including URL auth.
            // - Deleting an Authorization header that started explicit also means omit it.
            // - Otherwise, if the request did not start with explicit Authorization, Got may
            //   generate Basic auth from the current username/password.
            const authorizationWasExplicitlyOmitted = isHeaderExplicitlyOmitted('authorization')
                || (authorizationWasInitiallyExplicit
                    && !crossOriginHookStrippedHeaders.has('authorization')
                    && distribution.undefined(currentAuthorizationHeader));
            const cookieWasExplicitlyOmitted = distribution.undefined(currentCookieHeader)
                && (cookieWasInitiallyOmitted || isHeaderExplicitlyOmitted('cookie'));
            sanitizeHeaders();
            if (!distribution.undefined(currentHeaders['transfer-encoding']) && !distribution.undefined(currentHeaders['content-length'])) {
                options.deleteInternalHeader('content-length');
            }
            if (authorizationWasExplicitlyOmitted) {
                shouldOmitRequestUrlCredentials = true;
                options.deleteInternalHeader('authorization');
                if (changedState.has('authorization') && distribution.undefined(explicitAuthorizationHeader) && !authorizationWasInitiallyOmitted) {
                    delete options.headers.authorization;
                }
            }
            const authorizationHeader = !authorizationWasInitiallyExplicit
                && !authorizationWasInitiallyOmitted
                && !authorizationWasExplicitlyOmitted
                ? getAuthorizationHeader(options.username, options.password, authorizationWasExplicitlyOmitted)
                : undefined;
            const cookieJar = options.cookieJar;
            if (changedState.has('authorization') && !distribution.undefined(currentAuthorizationHeader)) {
                // A beforeRequest hook intentionally set the outgoing Authorization header.
            }
            else {
                const restorableAuthorizationHeader = crossOriginHookStrippedHeaders.has('authorization') || (changedState.has('authorization') && distribution.undefined(currentAuthorizationHeader))
                    ? undefined
                    : explicitAuthorizationHeader;
                syncGeneratedHeader('authorization', {
                    currentHeader: currentAuthorizationHeader,
                    explicitHeader: restorableAuthorizationHeader,
                    nextHeader: authorizationHeader,
                    staleGeneratedHeader: generatedAuthorizationHeader,
                });
            }
            if (cookieWasExplicitlyOmitted) {
                options.deleteInternalHeader('cookie');
                if (changedState.has('cookie') && distribution.undefined(explicitCookieHeader) && !cookieWasInitiallyOmitted) {
                    delete options.headers.cookie;
                }
            }
            else if (changedState.has('cookie')) {
                // A beforeRequest hook intentionally set the outgoing Cookie header.
            }
            else {
                const cookieHeader = !cookieWasInitiallyOmitted && !cookieWasExplicitlyOmitted
                    ? await getCookieHeader(cookieJar)
                    : undefined;
                const restorableCookieHeader = crossOriginHookStrippedHeaders.has('cookie')
                    ? undefined
                    : explicitCookieHeader;
                syncGeneratedHeader('cookie', {
                    currentHeader: currentCookieHeader,
                    explicitHeader: restorableCookieHeader,
                    nextHeader: cookieHeader,
                    staleGeneratedHeader: generatedCookieHeader,
                });
            }
        }
        request ??= options.getRequestFunction();
        const url = shouldOmitRequestUrlCredentials
            ? new URL(stripUrlAuth(options.url))
            : options.url;
        this._requestOptions = options.createNativeRequestOptions();
        if (shouldOmitRequestUrlCredentials) {
            this._requestOptions.auth = undefined;
        }
        // Streaming uploads cannot provide a cache key without consuming the body.
        const useCache = Boolean(options.cache) && (options.body === undefined || typeof options.body === 'string' || ArrayBuffer.isView(options.body));
        if (useCache) {
            Object.assign(this._requestOptions, {
                _request: request,
                cache: options.cache,
                body: options.body,
                beforeCacheHooks: options.hooks.beforeCache,
                gotRequest: this,
            });
            try {
                this._prepareCache(options.cache);
            }
            catch (error) {
                throw new CacheError(normalizeError(error), this);
            }
        }
        // Cache support
        const function_ = useCache ? this._createCacheableRequest : request;
        try {
            // We can't do `await fn(...)`,
            // because stream `error` event can be emitted before `Promise.resolve()`.
            // The request budget starts once the initial setup is done and is shared by every redirect.
            this._startedAt ??= Date.now();
            this._checkRequestTimeout();
            if (this._stopReading) {
                return;
            }
            let requestOrResponse = function_(url, this._requestOptions);
            if (distribution.promise(requestOrResponse)) {
                requestOrResponse = await requestOrResponse;
            }
            if (this._stopReading) {
                // The request timed out or was aborted while the request function was pending.
                destroyRequestResult(requestOrResponse);
                throw new AbortError(this);
            }
            if (is_client_request(requestOrResponse)) {
                this._onRequest(requestOrResponse, useCache);
            }
            else if (this.writableEnded) {
                void this._onResponse(requestOrResponse);
            }
            else {
                this.once('finish', () => {
                    void this._onResponse(requestOrResponse);
                });
                this._sendBody();
            }
        }
        catch (error) {
            if (error instanceof types_CacheError) {
                throw new CacheError(error, this);
            }
            throw error;
        }
    }
    async _error(error) {
        try {
            // Skip calling hooks for HTTP errors when throwHttpErrors is false (Promise API only).
            // See https://github.com/sindresorhus/got/issues/2103
            if (this.options && (!(error instanceof HTTPError) || this.options.throwHttpErrors)) {
                const hooks = this.options.hooks.beforeError;
                if (hooks.length > 0) {
                    for (const hook of hooks) {
                        // eslint-disable-next-line no-await-in-loop
                        error = await hook(error);
                        // Validate hook return value
                        if (!(error instanceof Error)) {
                            const received = error === null ? 'null' : (distribution.string(error) ? 'string' : (typeof error));
                            throw new TypeError(`The \`beforeError\` hook must return an Error instance. Received ${received}.`);
                        }
                    }
                    // Mark this error as processed by hooks so _destroy preserves custom error types.
                    // Only mark non-RequestError errors, since RequestErrors are already preserved
                    // by the instanceof check in _destroy (line 642).
                    if (!(error instanceof RequestError)) {
                        errorsProcessedByHooks.add(error);
                    }
                }
            }
        }
        catch (error_) {
            error = toRequestError(error_, this);
        }
        // A hook can install a body for a retry that will not happen. Nothing dispatched it, and
        // `_destroy` only tears down what was dispatched, so this request still owns it. The
        // undispatched case is `_destroy`'s own, which runs below.
        if (this._dispatchedBody !== undefined && this.options && this.options.body !== this._dispatchedBody.body) {
            this._destroyBody(this.options.body);
        }
        this.destroy(error);
        // Manually emit error for Promise API to ensure it receives it.
        // Node.js streams may not re-emit if an error was already emitted during retry attempts.
        // Only emit for Promise API (_noPipe = true) to avoid double emissions in stream mode.
        // Use process.nextTick to defer emission and allow destroy() to complete first.
        // See https://github.com/sindresorhus/got/issues/1995
        if (this._noPipe) {
            external_node_process_.nextTick(() => {
                this.emit('error', error);
            });
        }
    }
    _writeRequest(chunk, encoding, callback, request = this._request) {
        if (!request || request.destroyed) {
            // When there's no request (e.g., using cached response from beforeRequest hook),
            // we still need to call the callback to allow the stream to finish properly.
            callback();
            return;
        }
        request.write(chunk, encoding, (error) => {
            // The `!destroyed` check is required to prevent `uploadProgress` being emitted after the stream was destroyed.
            // The `this._request === request` check prevents stale write callbacks from a pre-redirect request from incrementing `_uploadedSize` after it's been reset.
            if (!error && !request.destroyed && this._request === request) {
                // For strings, encode them first to measure the actual bytes that will be sent
                const bytes = typeof chunk === 'string' ? external_node_buffer_.Buffer.from(chunk, encoding) : chunk;
                this._uploadedSize += byteLength(bytes);
                const progress = this.uploadProgress;
                if (progress.percent < 1) {
                    this.emit('uploadProgress', progress);
                }
            }
            callback(error);
        });
    }
    /**
    The remote IP address.
    */
    get ip() {
        return this.socket?.remoteAddress;
    }
    /**
    Indicates whether the request has been aborted or not.
    */
    get isAborted() {
        return this._aborted;
    }
    get socket() {
        return this._request?.socket ?? undefined;
    }
    /**
    Progress event for downloading (receiving a response).
    */
    get downloadProgress() {
        return makeProgress(this._downloadedSize, this._responseSize);
    }
    /**
    Progress event for uploading (sending a request).
    */
    get uploadProgress() {
        return makeProgress(this._uploadedSize, this._bodySize);
    }
    /**
    The object contains the following properties:

    - `start` - Time when the request started.
    - `socket` - Time when a socket was assigned to the request.
    - `lookup` - Time when the DNS lookup finished.
    - `connect` - Time when the socket successfully connected.
    - `secureConnect` - Time when the socket securely connected.
    - `upload` - Time when the request finished uploading.
    - `response` - Time when the request fired `response` event.
    - `end` - Time when the response fired `end` event.
    - `error` - Time when the request fired `error` event.
    - `abort` - Time when the request fired `abort` event.
    - `phases`
        - `wait` - `timings.socket - timings.start`
        - `dns` - `timings.lookup - timings.socket`
        - `tcp` - `timings.connect - timings.lookup`
        - `tls` - `timings.secureConnect - timings.connect`
        - `request` - `timings.upload - (timings.secureConnect || timings.connect)`
        - `firstByte` - `timings.response - timings.upload`
        - `download` - `timings.end - timings.response`
        - `total` - `(timings.end || timings.error || timings.abort) - timings.start`

    If something has not been measured yet, it will be `undefined`.

    __Note__: The time is a `number` representing the milliseconds elapsed since the UNIX epoch.
    */
    get timings() {
        return this._request?.timings;
    }
    /**
    Whether the response was retrieved from the cache.
    */
    get isFromCache() {
        return this.response?.isFromCache;
    }
    get reusedSocket() {
        return this._request?.reusedSocket;
    }
    /**
    Whether the stream is read-only. Returns `true` when `body`, `json`, or `form` options are provided.
    */
    get isReadonly() {
        return hasBodyOption(this.options);
    }
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/as-promise/index.js








const compressedEncodings = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd']);
const as_promise_proxiedRequestEvents = [
    'request',
    'redirect',
    'uploadProgress',
    'downloadProgress',
];
function asPromise(firstRequest) {
    let globalRequest;
    let globalResponse;
    const emitter = new external_node_events_.EventEmitter();
    let promiseSettled = false;
    const promise = new Promise((resolve, reject) => {
        const makeRequest = (retryCount, defaultOptions, retrySource) => {
            const request = firstRequest ?? new Request(undefined, undefined, defaultOptions, retrySource);
            request.retryCount = retryCount;
            request._noPipe = true;
            globalRequest = request;
            const setResponse = (response) => {
                globalResponse = response;
                request.response = response;
                response.ok = isResponseOk(response);
            };
            // Settles the promise and emits `response`. The event carries the response the promise settles
            // with, not the response of an attempt that is about to be retried or thrown.
            const resolveWithResponse = (response) => {
                request.destroy();
                promiseSettled = true;
                // The listener runs outside any request error handling, so a throw would otherwise
                // escape as an unhandled error and leave the promise pending. The later `resolve()` is
                // then a no-op.
                try {
                    emitter.emit('response', response);
                }
                catch (error) {
                    reject(normalizeError(error));
                }
                // eslint-disable-next-line unicorn/no-multiple-promise-resolver-calls
                resolve(request.options.resolveBodyOnly ? response.body : response);
            };
            request.once('response', (response) => {
                void (async () => {
                    // Parse body
                    const contentEncoding = (response.headers['content-encoding'] ?? '').toLowerCase();
                    const isCompressed = contentEncoding.split(',').some(encoding => compressedEncodings.has(encoding.trim()));
                    const { options } = request;
                    // Content-Encoding on a bodyless response describes the representation, not transferred bytes.
                    const hasNoBody = options.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 205 || response.statusCode === 304;
                    if (isCompressed && !options.decompress && !hasNoBody) {
                        response.body = response.rawBody;
                    }
                    else {
                        try {
                            response.body = parseBody(response, options.responseType, options.parseJson, options.encoding);
                        }
                        catch (error) {
                            // Preserve the response text when parsing fails.
                            try {
                                response.body = decodeUint8Array(response.rawBody, options.encoding);
                            }
                            catch (error) {
                                request._beforeError(new ParseError(normalizeError(error), response));
                                return;
                            }
                            if (isResponseOk(response)) {
                                request._beforeError(error);
                                return;
                            }
                        }
                    }
                    try {
                        const hooks = options.hooks.afterResponse;
                        for (const hook of hooks) {
                            const previousUrl = options.url ? new URL(options.url) : undefined;
                            const previousBoundary = getUrlPrefixBoundary(options);
                            const previousState = previousUrl ? snapshotCrossOriginState(options) : undefined;
                            const requestOptions = response.request.options;
                            const responseSnapshot = response;
                            // @ts-expect-error TS doesn't notice that RequestPromise is a Promise
                            // eslint-disable-next-line no-await-in-loop
                            response = await requestOptions.trackStateMutations(async (changedState) => hook(responseSnapshot, async (updatedOptions) => {
                                const preserveHooks = updatedOptions.preserveHooks ?? false;
                                if (updatedOptions === requestOptions) {
                                    const hasExplicitBody = hasBodyOptionChanged(changedState);
                                    options.clearUnchangedCookieHeader(previousState, changedState);
                                    const currentUrl = options.url;
                                    if (previousUrl
                                        && currentUrl instanceof URL
                                        && hasUrlOrPrefixUrlBoundaryChanged(options, currentUrl, previousBoundary)) {
                                        assertUrlHasSameOriginAsPrefixUrlIfNeeded(options, currentUrl);
                                    }
                                    if (updatedOptions.url !== undefined
                                        && previousUrl
                                        && !isSameOrigin(previousUrl, currentUrl)) {
                                        options.stripUnchangedCrossOriginState(previousState, changedState, { clearBody: !hasExplicitBody });
                                    }
                                }
                                else {
                                    options.mergeNextRequestOptions(updatedOptions, {
                                        previousUrl,
                                        previousState,
                                        previousBoundary,
                                    });
                                }
                                // RetryError interrupts this loop, so skip all response hooks on the retry by default.
                                // preserveHooks explicitly opts into running the complete hook list again.
                                if (!preserveHooks) {
                                    options.hooks.afterResponse = [];
                                }
                                throw new RetryError(request);
                            }));
                            if (!(distribution.object(response) && distribution.number(response.statusCode) && 'body' in response)) {
                                throw new TypeError('The `afterResponse` hook returned an invalid value');
                            }
                        }
                    }
                    catch (error) {
                        request._beforeError(error);
                        return;
                    }
                    setResponse(response);
                    if (!response.ok) {
                        request._beforeError(new HTTPError(response));
                        return;
                    }
                    resolveWithResponse(response);
                })();
            });
            let handledFinalError = false;
            const onError = (error) => {
                // Route errors emitted directly on the stream (e.g., EPIPE from Node.js)
                // through retry logic first, then handle them here after retries are exhausted.
                // See https://github.com/sindresorhus/got/issues/1995
                if (!request._stopReading) {
                    request._beforeError(error);
                    return;
                }
                // Allow the manual re-emission from Request to land only once.
                if (handledFinalError) {
                    return;
                }
                handledFinalError = true;
                promiseSettled = true;
                if (error instanceof HTTPError && !request.options.throwHttpErrors) {
                    setResponse(error.response);
                    resolveWithResponse(error.response);
                    return;
                }
                reject(error);
            };
            // Use .on() instead of .once() to keep the listener active across retries.
            // When _stopReading is false, we return early and the error gets re-emitted
            // after retry logic completes, so we need this listener to remain active.
            // See https://github.com/sindresorhus/got/issues/1995
            request.on('error', onError);
            let previousBody = request.options?.body;
            request.on('request', () => {
                // Async handlers and beforeRequest hooks can supply the body after this Promise was created.
                previousBody = request.options.body;
            });
            request.once('retry', (newRetryCount, error) => {
                firstRequest = undefined;
                // If promise already settled, don't retry
                // This prevents the race condition in #1489 where a late error
                // (e.g., ECONNRESET after successful response) triggers retry
                // after the promise has already resolved/rejected
                if (promiseSettled) {
                    return;
                }
                const newBody = request.options.body;
                if (previousBody === newBody && isNonReplayableBody(newBody)) {
                    error.message = 'Cannot retry with consumed body stream';
                    onError(error);
                    return;
                }
                // This is needed! We need to reuse `request.options` because they can get modified!
                // For example, by calling `promise.json()`.
                makeRequest(newRetryCount, request.options, request);
            });
            proxyEvents(request, emitter, as_promise_proxiedRequestEvents);
            if (distribution.undefined(firstRequest)) {
                void request.flush();
            }
        };
        makeRequest(0);
    });
    for (const method of ['on', 'once', 'off']) {
        promise[method] = function (event, function_) {
            emitter[method](event, function_);
            return this;
        };
    }
    const shortcut = (promiseToAwait, responseType) => {
        const newPromise = (async () => {
            // Wait until downloading has ended
            const response = await promiseToAwait;
            // Handlers may replace the response or recover one from a request error.
            if (!globalRequest.options.resolveBodyOnly && response?.request instanceof Request && response.rawBody instanceof Uint8Array) {
                globalResponse = response;
            }
            const { options } = globalResponse.request;
            // `parseBody` wraps a decode failure in a `ParseError`, so an unusable encoding is
            // reported with the response attached instead of as a bare `TypeError`.
            return parseBody(globalResponse, responseType, options.parseJson, options.encoding);
        })();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        Object.defineProperties(newPromise, Object.getOwnPropertyDescriptors(promiseToAwait));
        return newPromise;
    };
    // Note: These use `function` syntax (not arrows) to access `this` context.
    // When custom handlers wrap the promise to transform errors, these methods
    // are copied to the handler's promise. Using `this` ensures we await the
    // handler's wrapped promise, not the original, so errors propagate correctly.
    promise.json = function () {
        if (globalRequest.options) {
            const { headers } = globalRequest.options;
            if (!globalRequest.writableFinished && !('accept' in headers)) {
                headers.accept = 'application/json';
            }
        }
        return shortcut(this, 'json');
    };
    promise.buffer = function () {
        return shortcut(this, 'buffer');
    };
    promise.text = function () {
        return shortcut(this, 'text');
    };
    return promise;
}

;// CONCATENATED MODULE: ./node_modules/got/dist/source/create.js





const isGotInstance = (value) => distribution.function(value);
const aliases = [
    'get',
    'post',
    'put',
    'patch',
    'head',
    'delete',
    'query',
];
const assertNoUrlInOptionsObject = (options) => {
    if (Object.hasOwn(options, 'url')) {
        throw new TypeError('The `url` option is not supported in options objects. Pass it as the first argument instead.');
    }
};
const create = (defaults) => {
    defaults = {
        options: new Options(undefined, undefined, defaults.options),
        handlers: [...defaults.handlers],
        mutableDefaults: defaults.mutableDefaults,
    };
    // `body`, `json` and `form` are documented as never being merged with the instance
    // defaults, so a payload given to `got.extend()` must not reach the instance's requests.
    // Only the payload is dropped: an instance may still set the body headers it wants.
    defaults.options.body = undefined;
    defaults.options.json = undefined;
    defaults.options.form = undefined;
    Object.defineProperty(defaults, 'mutableDefaults', {
        enumerable: true,
        configurable: false,
        writable: false,
    });
    const makeRequest = (url, options, defaultOptions, isStream) => {
        if (distribution.plainObject(url)) {
            assertNoUrlInOptionsObject(url);
        }
        if (distribution.plainObject(options)) {
            assertNoUrlInOptionsObject(options);
        }
        // `isStream` is intentionally skipped by `merge()`.
        // Make the flag visible to `hooks.init` for both stream call forms.
        let requestInput = url;
        let requestOptions = options;
        if (isStream) {
            if (distribution.plainObject(url)) {
                requestInput = Object.defineProperties({}, Object.getOwnPropertyDescriptors(url));
                Reflect.set(requestInput, 'isStream', true);
            }
            else if (distribution.plainObject(options)) {
                requestOptions = Object.defineProperties({}, Object.getOwnPropertyDescriptors(options));
                Reflect.set(requestOptions, 'isStream', true);
            }
        }
        const request = new Request(requestInput, requestOptions, defaultOptions);
        if (isStream && request.options) {
            request.options.isStream = true;
        }
        // `request.options` stays unset when the input was rejected before the options were built,
        // and the request reports that itself. Otherwise the handler must pass the instance on.
        const optionsBuilt = request.options instanceof Options;
        let promise;
        const boundaryBeforeHandlers = request.options ? getUrlPrefixBoundary(request.options) : undefined;
        const lastHandler = (normalized) => {
            // `Options` keeps its state private, so a spread copy or a plain object would lose
            // everything and then fail later with an unrelated internal error.
            if (optionsBuilt && !(normalized instanceof Options)) {
                throw new TypeError('The `next()` function of a handler must be called with the `options` object it received');
            }
            if (boundaryBeforeHandlers?.url
                && normalized?.url instanceof URL
                && hasUrlOrPrefixUrlBoundaryChanged(normalized, normalized.url, boundaryBeforeHandlers)) {
                assertUrlHasSameOriginAsPrefixUrlIfNeeded(normalized, normalized.url);
            }
            // Note: `options` is `undefined` when `new Options(...)` fails
            request.options = normalized;
            const shouldReturnStream = normalized?.isStream ?? isStream;
            request._noPipe = !shouldReturnStream;
            void request.flush();
            if (shouldReturnStream) {
                return request;
            }
            promise ??= asPromise(request);
            return promise;
        };
        let iteration = 0;
        const iterateHandlers = (newOptions) => {
            const handler = defaults.handlers[iteration++] ?? lastHandler;
            const result = handler(newOptions, iterateHandlers);
            if (distribution.promise(result) && !request.options?.isStream) {
                promise ??= asPromise(request);
                if (result !== promise) {
                    const descriptors = Object.getOwnPropertyDescriptors(promise);
                    for (const key in descriptors) {
                        // `in` is deliberate: it also matches inherited names, and a promise carries `then`
                        // on its prototype, which must not be copied onto the result.
                        // eslint-disable-next-line unicorn/no-computed-property-existence-check
                        if (key in result) {
                            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                            delete descriptors[key];
                        }
                    }
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    Object.defineProperties(result, descriptors);
                }
            }
            return result;
        };
        return iterateHandlers(request.options);
    };
    // Got interface
    const got = ((url, options, defaultOptions = defaults.options) => makeRequest(url, options, defaultOptions, false));
    got.extend = (...instancesOrOptions) => {
        const options = new Options(undefined, undefined, defaults.options);
        const handlers = [...defaults.handlers];
        // `instance.extend(…)` must behave like `got.extend(instance, …)`, so the parent's mutability is inherited unless an argument overrides it.
        let { mutableDefaults } = defaults;
        for (const value of instancesOrOptions) {
            if (isGotInstance(value)) {
                options.merge(value.defaults.options);
                handlers.push(...value.defaults.handlers);
                mutableDefaults = value.defaults.mutableDefaults;
            }
            else {
                assertNoUrlInOptionsObject(value);
                options.merge(value);
                if (value.handlers) {
                    // A non-function entry would otherwise be skipped or crash inside the request
                    // without naming the option that caused it.
                    for (const [index, handler] of value.handlers.entries()) {
                        if (!distribution.function(handler)) {
                            throw new TypeError(`Expected \`handlers[${index}]\` to be a function, got \`${typeof handler}\``);
                        }
                    }
                    handlers.push(...value.handlers);
                }
                mutableDefaults = value.mutableDefaults ?? mutableDefaults;
            }
        }
        return create({
            options,
            handlers,
            mutableDefaults,
        });
    };
    // Pagination
    const paginateEach = (async function* (url, options) {
        if (distribution.plainObject(url)) {
            assertNoUrlInOptionsObject(url);
        }
        if (distribution.plainObject(options)) {
            assertNoUrlInOptionsObject(options);
        }
        let normalizedOptions = new Options(url, options, defaults.options);
        let { pagination } = normalizedOptions;
        assert.function(pagination.transform);
        assert.function(pagination.shouldContinue);
        assert.function(pagination.filter);
        assert.function(pagination.paginate);
        assert.number(pagination.countLimit);
        assert.number(pagination.requestLimit);
        assert.number(pagination.backoff);
        const allItems = [];
        let numberOfItems = 0;
        let numberOfRequests = 0;
        while (numberOfRequests < pagination.requestLimit && numberOfItems < pagination.countLimit) {
            if (numberOfRequests !== 0) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await (0,promises_.setTimeout)(pagination.backoff, undefined, { signal: normalizedOptions.signal });
                }
                catch (error) {
                    if (!normalizedOptions.signal?.aborted) {
                        throw error;
                    }
                    // Let the next request report cancellation through Got's normal error handling.
                }
            }
            // Pagination callbacks always receive the complete response.
            normalizedOptions.resolveBodyOnly = false;
            // eslint-disable-next-line no-await-in-loop
            const response = (await got(undefined, undefined, normalizedOptions));
            // eslint-disable-next-line no-await-in-loop
            const parsed = await pagination.transform(response);
            if (!distribution.array(parsed)) {
                // The same context the paginate override gets, so the failing page is not anonymous.
                throw new TypeError(`Option 'pagination.transform': Expected values which are \`Array\`. Received values of type \`${typeof parsed}\`.`);
            }
            const currentItems = [];
            for (const item of parsed) {
                if (!pagination.filter({ item, currentItems, allItems })) {
                    continue;
                }
                if (!pagination.shouldContinue({ item, currentItems, allItems })) {
                    return;
                }
                yield item;
                if (pagination.stackAllItems) {
                    allItems.push(item);
                }
                currentItems.push(item);
                if (++numberOfItems >= pagination.countLimit) {
                    return;
                }
            }
            if (++numberOfRequests >= pagination.requestLimit) {
                return;
            }
            const requestOptions = response.request.options;
            const previousUrl = requestOptions.url ? new URL(requestOptions.url) : undefined;
            const previousBoundary = getUrlPrefixBoundary(requestOptions);
            const previousState = previousUrl ? snapshotCrossOriginState(requestOptions) : undefined;
            // The inner `await` applies an async `paginate`, the same way `transform` is handled.
            // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-loop-func -- Pagination is updated only after this callback finishes.
            const [optionsToMerge, changedState] = await requestOptions.trackStateMutations(async (changedState) => [
                await pagination.paginate({
                    response,
                    currentItems,
                    allItems,
                }),
                changedState,
            ]);
            if (optionsToMerge === false) {
                return;
            }
            // A `paginate` that forgot its return value must be reported at the option, the same
            // way `transform` is, instead of crashing later while reading `url` off it.
            if (!(optionsToMerge instanceof Options) && !distribution.plainObject(optionsToMerge)) {
                throw new TypeError(`Option 'pagination.paginate': Expected \`false\` or a plain options object, got \`${typeof optionsToMerge}\``);
            }
            if (optionsToMerge === requestOptions) {
                normalizedOptions = requestOptions;
                normalizedOptions.clearUnchangedCookieHeader(previousState, changedState);
                const nextUrl = normalizedOptions.url;
                if (previousUrl && nextUrl) {
                    if (hasUrlOrPrefixUrlBoundaryChanged(normalizedOptions, nextUrl, previousBoundary)) {
                        assertUrlHasSameOriginAsPrefixUrlIfNeeded(normalizedOptions, nextUrl);
                    }
                    if (!isSameOrigin(previousUrl, nextUrl)) {
                        normalizedOptions.prefixUrl = '';
                        normalizedOptions.stripUnchangedCrossOriginState(previousState, changedState);
                    }
                }
            }
            else {
                const paginationBoundary = getUrlPrefixBoundary(normalizedOptions);
                const paginationUrl = paginationBoundary.url;
                try {
                    assert.any([distribution.string, distribution.urlInstance, distribution.undefined], optionsToMerge.url);
                }
                catch (error) {
                    if (error instanceof Error) {
                        error.message = `Option 'pagination.paginate.url': ${error.message}`;
                    }
                    throw error;
                }
                const { nextUrl, hasExplicitBody } = normalizedOptions.mergeNextRequestOptions(optionsToMerge, {
                    previousUrl,
                    previousState,
                    previousBoundary: paginationBoundary,
                    baseUrl: previousUrl,
                });
                if (previousUrl
                    && paginationUrl
                    && !isSameOrigin(paginationUrl, previousUrl)) {
                    normalizedOptions.stripSensitiveHeaders(paginationUrl, previousUrl, optionsToMerge);
                    if (!hasExplicitBody) {
                        normalizedOptions.clearBody();
                    }
                }
                if (nextUrl
                    && (normalizedOptions.prefixUrl.toString() !== paginationBoundary.prefixUrl
                        || normalizedOptions.allowAbsoluteUrls !== paginationBoundary.allowAbsoluteUrls)) {
                    assertUrlHasSameOriginAsPrefixUrlIfNeeded(normalizedOptions, nextUrl);
                }
            }
            pagination = normalizedOptions.pagination;
        }
    });
    got.paginate = paginateEach;
    got.paginate.all = (async (url, options) => Array.fromAsync(paginateEach(url, options)));
    // For those who like very descriptive names
    got.paginate.each = paginateEach;
    // Stream API
    got.stream = ((url, options) => makeRequest(url, options, defaults.options, true));
    // Shortcuts
    for (const method of aliases) {
        got[method] = ((url, options) => got(url, { ...options, method }));
        got.stream[method] = ((url, options) => makeRequest(url, { ...options, method }, defaults.options, true));
    }
    if (!defaults.mutableDefaults) {
        Object.freeze(defaults);
        Object.freeze(defaults.handlers);
        defaults.options.freeze();
    }
    Object.defineProperty(got, 'defaults', {
        value: defaults,
        writable: false,
        configurable: false,
        enumerable: true,
    });
    return got;
};
/* harmony default export */ const source_create = (create);

;// CONCATENATED MODULE: ./node_modules/got/dist/source/index.js


const defaults = {
    options: new Options(),
    handlers: [],
    mutableDefaults: false,
};
const got = source_create(defaults);
/* harmony default export */ const source = (got);











/***/ })

};
;