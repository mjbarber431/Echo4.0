import SwiftUI

extension Color {
    /// The deep green of Echo's icon, behind the recording screen and the lock screen.
    static let echoDeep = Color(red: 0.14, green: 0.33, blue: 0.29)
    static let echoDeeper = Color(red: 0.09, green: 0.22, blue: 0.19)
}

extension ShapeStyle where Self == LinearGradient {
    static var echoBackground: LinearGradient {
        LinearGradient(colors: [.echoDeep, .echoDeeper], startPoint: .top, endPoint: .bottom)
    }
}

/// The waveform mark from Echo's icon.
struct EchoMark: View {
    var size: CGFloat = 64

    var body: some View {
        HStack(alignment: .center, spacing: size * 0.1) {
            ForEach(Array([0.34, 0.62, 1.0, 0.62, 0.34].enumerated()), id: \.offset) { i, h in
                Capsule()
                    .fill(.white.opacity([0.6, 0.85, 1, 0.85, 0.6][i]))
                    .frame(width: size * 0.12, height: size * h)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

extension Date {
    /// "Today, 2:14 PM", "Yesterday, 9:03 AM", "Mon, Oct 19, 4:30 PM"
    var friendly: String {
        let time = formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(self) { return "Today, \(time)" }
        if Calendar.current.isDateInYesterday(self) { return "Yesterday, \(time)" }
        return formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
    }
}
