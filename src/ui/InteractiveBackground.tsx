import { useState } from "react"

export const InteractiveBackground = () => {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)

  return <canvas ref={setCanvas} className="chart__canvas" />
}
