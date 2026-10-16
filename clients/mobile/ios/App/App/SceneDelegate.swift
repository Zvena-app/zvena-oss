import UIKit
import Capacitor

/// The window with the zvena web app, and the links iOS hands it: zvena://
/// links, universal links (https://zvena.app/docs…) and items the share
/// extension left. Each opens its page in the app's web view, only on the
/// app's own origin (Links); Capacitor's plugins still get every event.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    private var bridgeController: CAPBridgeViewController? { window?.rootViewController as? CAPBridgeViewController }
    private var appURL: String? { bridgeController?.bridge?.config.serverURL.absoluteString }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        // A cold start by a link: open it after the web view's first load has begun.
        if let url = connectionOptions.urlContexts.first?.url {
            DispatchQueue.main.async { self.open(url) }
        } else if let activity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }), let url = activity.webpageURL {
            DispatchQueue.main.async { self.open(url) }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
        if let url = URLContexts.first?.url { open(url) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL { open(url) }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // A share the extension could not hand over by opening the app.
        guard let app = appURL, let target = PendingShare.take(appURL: app) else { return }
        load(target)
    }

    private func open(_ url: URL) {
        guard let app = appURL, let target = Links.resolve(url.absoluteString, appURL: app) else { return }
        // The share extension opened the app with the item: its App Group copy is done with.
        if url.scheme == "zvena" && url.host == "clip" { PendingShare.clear() }
        load(target)
    }

    private func load(_ url: URL) {
        bridgeController?.bridgedWebView?.load(URLRequest(url: url))
    }
}
