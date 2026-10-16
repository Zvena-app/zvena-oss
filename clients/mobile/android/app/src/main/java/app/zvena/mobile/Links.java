package app.zvena.mobile;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which addresses the app opens and where shared items go: the rules of
 * src/links.js (pinned by test/links.test.mjs), mirrored for Android.
 * zvena://docs?… → APP_URL/docs?…; zvena://open?url=… only on the app's
 * origin; https links only for the claimed paths of that origin.
 */
final class Links {
    static final String[] LINK_PATHS = { "/docs", "/n/", "/share/", "/join/", "/projects", "/home", "/inbox", "/clip" };
    private static final int MAX = 8000;
    private static final Pattern USER_INFO = Pattern.compile("^zvena://[^/?#]*@", Pattern.CASE_INSENSITIVE);
    private static final Pattern BAD_PATH = Pattern.compile("\\\\|%2f|%5c", Pattern.CASE_INSENSITIVE);
    private static final Pattern URL_IN_TEXT = Pattern.compile("https?://[^\\s<>\"']+", Pattern.CASE_INSENSITIVE);

    private Links() {}

    /** scheme://host[:port] of an http(s) URL, or null. */
    static String origin(String raw) {
        try {
            URI u = new URI(raw);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            if ((!scheme.equals("https") && !scheme.equals("http")) || u.getHost() == null || u.getRawUserInfo() != null) return null;
            int port = u.getPort();
            boolean dflt = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
            return scheme + "://" + u.getHost().toLowerCase() + (dflt ? "" : ":" + port);
        } catch (URISyntaxException e) {
            return null;
        }
    }

    private static String sameOrigin(String raw, String appOrigin) {
        String o = origin(raw);
        return o != null && o.equals(appOrigin) ? raw : null;
    }

    private static boolean claimed(String path) {
        if (path == null) return false;
        for (String p : LINK_PATHS) {
            if (p.endsWith("/") ? path.startsWith(p) : path.equals(p) || path.startsWith(p + "/")) return true;
        }
        return false;
    }

    /** The page to load for a deep link, universal link or App Link; null: ignore it. */
    static String resolve(String raw, String appUrl) {
        String appOrigin = origin(appUrl);
        if (raw == null || raw.isEmpty() || raw.length() > MAX || appOrigin == null) return null;
        URI u;
        try {
            u = new URI(raw);
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (scheme.equals("https") || scheme.equals("http")) {
            return sameOrigin(raw, appOrigin) != null && claimed(u.getRawPath()) ? raw : null;
        }
        if (!scheme.equals("zvena") || USER_INFO.matcher(raw).find()) return null;
        String head = ((u.getRawAuthority() == null ? "" : u.getRawAuthority()) + (u.getRawPath() == null ? "" : u.getRawPath())).replaceFirst("^/+", "");
        if (head.equals("open")) {
            String target = param(u.getRawQuery(), "url");
            return target == null || target.isEmpty() ? appOrigin + "/" : sameOrigin(target, appOrigin);
        }
        if (BAD_PATH.matcher(head).find()) return null;
        String out = appOrigin + "/" + head + (u.getRawQuery() != null ? "?" + u.getRawQuery() : "") + (u.getRawFragment() != null ? "#" + u.getRawFragment() : "");
        return sameOrigin(out, appOrigin);
    }

    /** The first http(s) URL in shared text, without trailing punctuation. */
    static String firstUrl(String text) {
        if (text == null) return "";
        Matcher m = URL_IN_TEXT.matcher(text);
        return m.find() ? m.group().replaceFirst("[).,;:!?\\]]+$", "") : "";
    }

    /** The web app's "Save to zvena" screen, filled in with what was shared (it saves only after a tap there). */
    static String clipUrl(String text, String subject, String appUrl) {
        String appOrigin = origin(appUrl);
        if (appOrigin == null) return null;
        String t = text == null ? "" : text.length() > MAX ? text.substring(0, MAX) : text;
        String url = firstUrl(t);
        String rest = (url.isEmpty() ? t : t.replace(url, " ")).replaceAll("\\s+", " ").trim();
        StringBuilder q = new StringBuilder();
        add(q, "url", url);
        add(q, "title", subject == null ? "" : cut(subject, 300));
        add(q, "text", cut(rest, 4000));
        return appOrigin + "/clip" + (q.length() > 0 ? "?" + q : "");
    }

    private static String cut(String s, int n) {
        return s.length() > n ? s.substring(0, n) : s;
    }

    private static void add(StringBuilder q, String k, String v) {
        if (v == null || v.isEmpty()) return;
        if (q.length() > 0) q.append('&');
        try {
            q.append(k).append('=').append(URLEncoder.encode(v, "UTF-8"));
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String param(String rawQuery, String name) {
        if (rawQuery == null) return null;
        for (String part : rawQuery.split("&")) {
            int i = part.indexOf('=');
            String k = i < 0 ? part : part.substring(0, i);
            if (!k.equals(name)) continue;
            try {
                return URLDecoder.decode(i < 0 ? "" : part.substring(i + 1), "UTF-8");
            } catch (UnsupportedEncodingException | IllegalArgumentException e) {
                return null;
            }
        }
        return null;
    }
}
