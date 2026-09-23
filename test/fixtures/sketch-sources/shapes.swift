import Foundation

/** A 2D shape. */
protocol Shape {
    var area: Double { get }
}

struct Circle: Shape {
    let radius: Double
    var area: Double { .pi * radius * radius }
}

/** Squares have equal sides. */
class Square: Shape {
    var side: Double
    init(side: Double) { self.side = side }
    var area: Double { side * side }
}

enum Unit: String {
    case metre, foot
}

func totalArea(_ shapes: [Shape]) -> Double {
    shapes.reduce(0) { $0 + $1.area }
}
