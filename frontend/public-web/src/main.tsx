import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles.css'

const container = document.getElementById('root')

// 宿主页缺少挂载容器时立即失败，避免应用以空白界面继续启动。
if (container === null) {
  throw new Error('Missing root element')
}

// 公开站入口加载后挂载根组件，由其发现普通用户身份并解析当前浏览路径。
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
