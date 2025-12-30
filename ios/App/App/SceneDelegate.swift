import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    // cold start
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let _ = (scene as? UIWindowScene) else { return }
        if let urlContext = connectionOptions.urlContexts.first {
            startPulseInjector(url: urlContext.url)
        }
    }

    // warm resume
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url {
            startPulseInjector(url: url)
        }
    }

    // pulse inject
    private func startPulseInjector(url: URL) {
        let urlStr = url.absoluteString
        print("⚡️ [SceneDelegate] Starting Pulse Injector for: \(urlStr)")
        
        // fire 10 times, every 0.5s
        for i in 0...10 {
            let delay = Double(i) * 0.5
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.injectJS(urlStr: urlStr, attempt: i)
            }
        }
    }

    private func injectJS(urlStr: String, attempt: Int) {
        guard let bridgeVC = self.window?.rootViewController as? CAPBridgeViewController else { return }
        
        // only run if the function exists
        let js = "if (window.handleOpenUrl) { window.handleOpenUrl('\(urlStr)'); } else { console.log('⚡️ [iOS] Vue not ready yet...'); }"
        
        bridgeVC.webView?.evaluateJavaScript(js) { (_, _) in
            // we dont care about errors
        }
    }

    // lifecycle boilerplate
    func sceneDidBecomeActive(_ scene: UIScene) {}
    func sceneWillResignActive(_ scene: UIScene) {}
    func sceneWillEnterForeground(_ scene: UIScene) {}
    func sceneDidEnterBackground(_ scene: UIScene) {}
}
