import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'

const container = document.getElementById('root')

// 宿主页缺少挂载容器时立即失败，避免应用以空白界面继续启动。
if (container === null) {
  throw new Error('Missing root element')
}

// 管理站入口加载后挂载根组件，由其发现管理员会话并选择后台页面。
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
