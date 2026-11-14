import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    // Vitest turns every stylesheet into an empty module by default; the game scene tests read
    // styles.css as text (`?raw`) to check the control bar rules, so this one file stays real.
    css: { include: [/ui\/styles\.css/] },
  },
});
