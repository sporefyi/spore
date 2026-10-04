import { useEffect, useRef } from "react";

/**
 * A tiny live mushroom that emits spores in real time.
 * Rendered beside the Playground nav link. Canvas-based particle
 * emission (moss/amber spores rising from the cap), DPR-capped,
 * paused off-screen and under prefers-reduced-motion.
 */
export function NavSpore({ size = 22 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const g = ctx as CanvasRenderingContext2D;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = size * 2; // emission field wider than the mushroom
    const H = size * 2;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    type Spore = {
      x: number; y: number; vx: number; vy: number;
      r: number; life: number; maxLife: number; hue: number;
    };
    const spores: Spore[] = [];
    let raf = 0;
    let running = true;
    let last = performance.now();
    let emitAcc = 0;

    const capX = W / 2;
    const capY = H * 0.62; // mushroom cap sits lower-center; canvas overlays the icon

    function spawn() {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
      const speed = 8 + Math.random() * 14;
      spores.push({
        x: capX + (Math.random() - 0.5) * size * 0.5,
        y: capY - 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: 0.8 + Math.random() * 1.4,
        life: 0,
        maxLife: 1.6 + Math.random() * 1.4,
        hue: Math.random() < 0.7 ? 95 : 32, // moss vs amber
      });
      if (spores.length > 26) spores.shift();
    }

    function tick(now: number) {
      if (!running) return;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      emitAcc += dt;
      while (emitAcc > 0.28) { emitAcc -= 0.28; spawn(); }

      g.clearRect(0, 0, W, H);
      for (let i = spores.length - 1; i >= 0; i--) {
        const s = spores[i];
        s.life += dt;
        if (s.life >= s.maxLife) { spores.splice(i, 1); continue; }
        s.x += (s.vx + Math.sin((s.life + i) * 3) * 6) * dt;
        s.y += s.vy * dt;
        s.vy *= 1 - 0.4 * dt;
        const t = s.life / s.maxLife;
        const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        g.beginPath();
        g.arc(s.x, s.y, s.r * (1 - t * 0.4), 0, Math.PI * 2);
        g.fillStyle = `hsla(${s.hue}, 55%, 62%, ${(alpha * 0.9).toFixed(3)})`;
        g.shadowColor = `hsla(${s.hue}, 60%, 55%, 0.8)`;
        g.shadowBlur = 5;
        g.fill();
        g.shadowBlur = 0;
      }
      raf = requestAnimationFrame(tick);
    }

    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(tick); }
      else if (!e.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
    });
    io.observe(canvas);
    raf = requestAnimationFrame(tick);

    return () => { running = false; cancelAnimationFrame(raf); io.disconnect(); };
  }, [size]);

  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }} aria-hidden="true">
      {/* mushroom */}
      <svg width={size} height={size} viewBox="0 0 22 22" className="block">
        {/* stem */}
        <rect x="9.6" y="10" width="2.8" height="8" rx="1.2" fill="#e8ddc4" opacity="0.92" />
        {/* cap */}
        <path d="M3 11.5C3 6.8 6.6 3.5 11 3.5s8 3.3 8 8c0 1-0.8 1.6-1.9 1.4C15.4 12.6 13.3 12 11 12s-4.4 0.6-6.1 0.9C3.8 13.1 3 12.5 3 11.5Z" fill="#d9772b" />
        <path d="M3 11.5C3 6.8 6.6 3.5 11 3.5c1.4 0 2.7 0.3 3.8 0.9C10.6 5.6 7.6 8.4 7.2 12.7c-0.8 0.1-1.6 0.1-2.3 0.2C3.8 13.1 3 12.5 3 11.5Z" fill="#b85f1d" opacity="0.55" />
        {/* cap spots */}
        <circle cx="8" cy="7.5" r="1.3" fill="#f0e9da" opacity="0.85" />
        <circle cx="13.5" cy="6.2" r="1" fill="#f0e9da" opacity="0.7" />
        <circle cx="15.5" cy="9.5" r="0.8" fill="#f0e9da" opacity="0.6" />
        {/* moss glow at base */}
        <ellipse cx="11" cy="18.6" rx="5" ry="1.2" fill="#8fae5a" opacity="0.35" />
      </svg>
      {/* live spore emission field */}
      <canvas ref={canvasRef} className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
    </span>
  );
}
