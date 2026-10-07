import Foundation
import CoreGraphics
import Darwin

// F8 is a normal virtual key (kVK_F8 = 100), so polling its physical key
// state is more reliable than treating a left/right modifier as a hotkey.
// On Mac keyboards whose top row controls media, hold Fn+F8.
let muteKey: CGKeyCode = 100
var lastDown = false

func emit(_ text: String) {
    print(text)
    fflush(stdout)
}

emit("READY")

while true {
    autoreleasepool {
        // hidSystemState asks CoreGraphics for the current hardware key state.
        let down = CGEventSource.keyState(.hidSystemState, key: muteKey)
        if down != lastDown {
            lastDown = down
            emit(down ? "MUTE_DOWN" : "MUTE_UP")
        }
    }
    usleep(12_000)
}
