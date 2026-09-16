import { createApp } from 'vue'
import TDesign from 'tdesign-vue-next'
import 'tdesign-vue-next/es/style/index.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
import './style.css'
import App from './App.vue'
import { router } from './router'

// 宿主全局的退化实现：源页直接调用裸标识符 `defineWujiPageMeta({title})`，
// 页面代码因此一字不改。只保留「设 title」这一条真实行为。
window.defineWujiPageMeta = (o) => {
  if (o?.title) document.title = o.title
}

createApp(App).use(TDesign).use(router).mount('#app')
