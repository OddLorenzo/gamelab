const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const ctx = canvas?.getContext('2d') ?? null;

if (canvas && ctx) {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = '24px sans-serif';
  ctx.fillText('Monkey Bomb', 20, 40);
}
