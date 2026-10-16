import XCTest

final class ClientSmokeTests: XCTestCase {
    func testConnectionPersistenceAndNativeControls() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "chat.lumiverse.ios")
        app.launch()
        let field = app.webViews.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText("http://127.0.0.1:18763")
        app.webViews.buttons["Connect"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Remote Lumiverse"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.webViews.staticTexts["Native commands blocked"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["iOS mobile identity verified"].exists)
        XCTAssertTrue(app.webViews.staticTexts["Native permissions verified"].waitForExistence(timeout: 10))
        app.webViews.buttons["Try native dictation"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        let deny = alert.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Don")).firstMatch
        XCTAssertTrue(deny.exists)
        deny.tap()
        XCTAssertTrue(app.webViews.staticTexts["Speech permission denial handled"].waitForExistence(timeout: 10))

        XCTAssertFalse(app.buttons["lumiverse.native.actions"].exists)
        XCTAssertFalse(app.buttons["lumiverse.accessibility.actions"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 0.9)
        XCTAssertFalse(app.buttons["Share this page"].exists)
        // XCTest has no two-finger hold API. A tiny, slow pinch keeps both
        // touches within the recognizer's movement tolerance for over 650 ms.
        app.webViews.firstMatch.pinch(withScale: 1.05, velocity: 0.025)
        XCTAssertTrue(app.buttons["Share this page"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Check animation frame rate"].exists)
        XCTAssertTrue(app.buttons["App permissions"].exists)
        let controlsScreenshot = XCTAttachment(screenshot: app.screenshot())
        controlsScreenshot.name = "Lumiverse native controls"
        controlsScreenshot.lifetime = .keepAlways
        add(controlsScreenshot)
        app.buttons["Share this page"].tap()
        let copy = app.descendants(matching: .any).matching(identifier: "Copy").firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 10))
        copy.tap()

        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.staticTexts["Remote Lumiverse"].waitForExistence(timeout: 20))
        app.webViews.firstMatch.pinch(withScale: 1.05, velocity: 0.025)
        app.buttons["Change server"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertEqual(field.value as? String, "http://127.0.0.1:18763/")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Lumiverse connection screen"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
