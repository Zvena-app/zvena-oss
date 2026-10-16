import Foundation

/// Which addresses the app opens: the rules of src/links.js (pinned by
/// test/links.test.mjs), mirrored for iOS. zvena://docs?… → APP_URL/docs?…;
/// zvena://open?url=… only on the app's origin; universal links only for the
/// claimed paths of that origin.
enum Links {
    static let linkPaths = ["/docs", "/n/", "/share/", "/join/", "/projects", "/home", "/inbox", "/clip"]
    private static let max = 8000

    /// scheme://host[:port] of an http(s) URL, or nil.
    static func origin(_ raw: String) -> String? {
        guard let c = URLComponents(string: raw), let scheme = c.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = c.host?.lowercased(), !host.isEmpty, c.user == nil, c.password == nil else { return nil }
        let port = c.port
        let dflt = port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        return dflt ? "\(scheme)://\(host)" : "\(scheme)://\(host):\(port!)"
    }

    private static func sameOrigin(_ raw: String, _ appOrigin: String) -> URL? {
        guard origin(raw) == appOrigin else { return nil }
        return URL(string: raw)
    }

    private static func claimed(_ path: String) -> Bool {
        linkPaths.contains { p in p.hasSuffix("/") ? path.hasPrefix(p) : path == p || path.hasPrefix(p + "/") }
    }

    /// The page to load for a deep link or universal link; nil: ignore it.
    static func resolve(_ raw: String, appURL: String) -> URL? {
        guard let appOrigin = origin(appURL), !raw.isEmpty, raw.count <= max, let u = URLComponents(string: raw), let scheme = u.scheme?.lowercased() else { return nil }
        if scheme == "https" || scheme == "http" {
            return claimed(u.percentEncodedPath) ? sameOrigin(raw, appOrigin) : nil
        }
        // No user info ("zvena://x@host"): the path is all there is.
        guard scheme == "zvena", raw.range(of: "^zvena://[^/?#]*@", options: [.regularExpression, .caseInsensitive]) == nil else { return nil }
        var head = (u.percentEncodedHost ?? "") + u.percentEncodedPath
        while head.hasPrefix("/") { head.removeFirst() }
        if head == "open" {
            guard let target = u.queryItems?.first(where: { $0.name == "url" })?.value, !target.isEmpty else { return URL(string: appOrigin + "/") }
            return sameOrigin(target, appOrigin)
        }
        if head.range(of: "\\\\|%2f|%5c", options: [.regularExpression, .caseInsensitive]) != nil { return nil }
        var out = appOrigin + "/" + head
        if let q = u.percentEncodedQuery { out += "?" + q }
        if let f = u.percentEncodedFragment { out += "#" + f }
        return sameOrigin(out, appOrigin)
    }
}

/// What the share extension left in the App Group for the app to finish
/// (Save to zvena), when it could not open the app itself.
enum PendingShare {
    static let group = "group.app.zvena.mobile"
    static let key = "pendingShare"

    /// The Save to zvena page for a share made in the last ten minutes, once.
    static func take(appURL: String) -> URL? {
        guard let defaults = UserDefaults(suiteName: group), let item = defaults.dictionary(forKey: key) else { return nil }
        defaults.removeObject(forKey: key)
        guard let at = item["at"] as? Double, Date().timeIntervalSince1970 - at < 600, let clip = item["clip"] as? String else { return nil }
        return Links.resolve(clip, appURL: appURL)
    }

    static func clear() {
        UserDefaults(suiteName: group)?.removeObject(forKey: key)
    }
}
