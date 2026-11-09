import { useRef, useEffect } from "react"

export function InteractiveBackground(): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return

    // mouseX / mouseY
    const mouse = { x: -1e9, y: -1e9 }
    const onMove = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect()
      mouse.x = e.clientX - r.left
      mouse.y = e.clientY - r.top
    }

    // createCanvas + windowResized
    let width = 0
    let height = 0
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // from here on, draw in CSS pixels
    }
    const observer = new ResizeObserver(resize) // also fires once on observe
    observer.observe(canvas)

    // draw()
    let frame = 0
    const draw = (time: number): void => {
      ctx.clearRect(0, 0, width, height)
      // your sketch: width, height, mouse, time
      ctx.fillStyle = "blue"

      const CELL_SIZE = 50
      const cells_by_row = Math.round((width - CELL_SIZE) / CELL_SIZE)

      for (let x = CELL_SIZE; x < width - CELL_SIZE / 4; x += CELL_SIZE)
        for (let y = CELL_SIZE; y < height - CELL_SIZE / 4; y += CELL_SIZE) {
          // ctx.fillRect(x, y, Math.cos(time / 1000 + x) * 5, Math.sin(time / 1000 + y) * 5)

          const index_x = x / CELL_SIZE
          const index_y = y / CELL_SIZE

          ctx.beginPath()

          ctx.strokeStyle = "#ffffff"
          ctx.globalAlpha = 0.05

          ctx.strokeRect(x - CELL_SIZE / 2, y - CELL_SIZE / 2, CELL_SIZE, CELL_SIZE)
          // ctx.moveTo(x - 5, y - 5)
          // ctx.lineTo(x + 5, y + 5)
          // ctx.beginPath()
          // ctx.arc(x, y, Math.abs(Math.cos(time / 1000 + y + x)) * 5 + 1, 0, Math.PI * 2, true)

          // // ctx.lineTo(Math.cos(time / 1000 + x), 45)
          // ctx.strokeStyle = "RGB(50,50,200)"
          // ctx.globalAlpha = Math.abs(Math.cos(time / 1000 + x - y))
          // ctx.strokeStyle = `rgb(${(mouse.x - x) * 360} ${(mouse.y - y) * 100} 100)`

          ctx.closePath()
          ctx.stroke()
          ctx.globalAlpha = 1

          const index = (index_y - 1) * cells_by_row + index_x
          ctx.textAlign = "center"
          ctx.fillText(`${index_x}, ${index_y}`, x, y - 5)
          ctx.fillText(`${index}`, x, y + 5)
        }

      ctx.strokeStyle = "red"
      ctx.fillStyle = "red"

      ctx.fillRect(mouse.x - 5, mouse.y - 5, 10, 10)
      ctx.strokeRect(-1, -1, mouse.x, mouse.y)
      ctx.fillText(mouse.x.toString(), mouse.x / 2, mouse.y - 10)
      ctx.textAlign = "right"
      ctx.fillText(mouse.y.toString(), mouse.x - 10, mouse.y / 2)

      // ctx.lineTo(0, mouse.y)
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    window.addEventListener("pointermove", onMove)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("pointermove", onMove)
    }
  }, [])

  return (
    <canvas ref={ref} className="background">
      ERAS Tool Interactive Background
    </canvas>
  )
}
