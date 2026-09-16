/** @type {import('tailwindcss').Config} */
export default {
  // 只扫移动端自己的源码：扫到仓根会把 console 的类也编译进来（产物没人用还变大）。
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: { extend: {} },
  plugins: [],
}
