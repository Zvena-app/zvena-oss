import UIKit
import UniformTypeIdentifiers

/// "Save to zvena" in the iOS share sheet. An extension cannot use the app's
/// session (its web view has a store of its own), so it hands the item over:
/// it writes it to the App Group and opens the app at zvena://clip?…, where
/// the web app's Save to zvena screen takes it (saving needs a tap there).
/// If iOS does not let it open the app, the app picks the item up the next
/// time it comes to the front (PendingShare in Links.swift).
final class ShareViewController: UIViewController {
    private static let group = "group.app.zvena.mobile"
    private static let max = 4000

    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.text = NSLocalizedString("saving", comment: "")
        label.font = .preferredFont(forTextStyle: .body)
        label.textColor = .label
        label.numberOfLines = 0
        label.textAlignment = .center
        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
        spinner.startAnimating()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await handOver() }
    }

    private func handOver() async {
        let (url, text, title) = await sharedItem()
        guard url != nil || !(text ?? "").isEmpty else {
            show(NSLocalizedString("empty", comment: ""))
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            done()
            return
        }
        var q = URLComponents()
        q.scheme = "zvena"
        q.host = "clip"
        q.queryItems = [
            url.map { URLQueryItem(name: "url", value: $0.absoluteString) },
            title.map { URLQueryItem(name: "title", value: String($0.prefix(300))) },
            text.flatMap { $0.isEmpty ? nil : URLQueryItem(name: "text", value: String($0.prefix(Self.max))) },
        ].compactMap { $0 }
        guard let link = q.url else { return done() }
        UserDefaults(suiteName: Self.group)?.set(["clip": link.absoluteString, "at": Date().timeIntervalSince1970], forKey: "pendingShare")
        show(NSLocalizedString("opening", comment: ""))
        openApp(link)
        try? await Task.sleep(nanoseconds: 400_000_000)
        done()
    }

    /// The shared web page (or the first link in shared text), the text without it, and a title.
    private func sharedItem() async -> (URL?, String?, String?) {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var url: URL?
        var text: String?
        let title = items.first?.attributedContentText?.string
        for provider in items.flatMap({ $0.attachments ?? [] }) {
            if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let u = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
               u.scheme == "https" || u.scheme == "http" {
                url = u
            } else if text == nil, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let t = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                text = t
            }
        }
        if url == nil, let t = text, let found = Self.firstURL(in: t) {
            url = found
            text = t.replacingOccurrences(of: found.absoluteString, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // Safari puts the page title in the item's text; it is not the note's body.
        return (url, text == title ? nil : text, title)
    }

    private static func firstURL(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let match = detector.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
        guard let u = match?.url, u.scheme == "https" || u.scheme == "http" else { return nil }
        return u
    }

    /// Extensions get no UIApplication; the responder chain reaches the host's
    /// (needs APPLICATION_EXTENSION_API_ONLY = NO for this target).
    private func openApp(_ url: URL) {
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return
            }
            responder = r.next
        }
    }

    private func show(_ text: String) {
        label.text = text
    }

    private func done() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
