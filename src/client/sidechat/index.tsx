/**
 * Workitem 01 — 侧边聊天面板。
 *
 * 注册「侧边聊天」Tab 类型（dsh-sidechat:side，多实例一等公民）：
 * - + 菜单可见（order 60，terminal=40 / browser=50 之后）；菜单行标题
 *   「侧边聊天」，铸造出的 Tab 标题为「侧边」/「侧边 N」（createTab 按
 *   当前并存数编号 —— 带 createTab 的 descriptor 会被 openTab 忽略
 *   seed.title，编号必须在铸造处完成）；
 * - createTab 铸 `side:<uuid>`（crypto.randomUUID()）多实例 id；
 * - blank 着陆页会话没有已完成 turn、fork 必败 → available 禁用 +
 *   面板内错误态双保险；
 * - Tab × 关闭即从界面消失（better-sidebar 关 tab 即出布局，meta 随之
 *   消失；jsonl 留盘是设计意图，不做删除）。
 *
 * /side command remains an optional second entry point.
 */
import { IconNewChatOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { observeAnnotationCore } from '../annotation-core-resolver.ts'
import { annotationSafetyGuard } from '../annotation-safety-guard.ts'
import { SideChatPanel } from './SideChatPanel.tsx'
import { SIDE_TAB_TYPE, canForkFrom, collectSideTabs, mintSideTabId, sideTabTitle } from './model.ts'
import { releaseSideChatSession } from './session-controller.ts'
import { t } from '../locales.ts'
import { registerSideCommand } from './slash.ts'
import { createModelRouteStore } from './model-route-store.ts'
import { SidechatModelCoordinator } from './model-coordinator.ts'

export function registerSideChat(ctx: Context): void {
  const modelRoutes = createModelRouteStore()
  const modelCoordinator = new SidechatModelCoordinator(modelRoutes, ctx.sessions)
  ctx.effect(() => () => {
    modelCoordinator.dispose()
    modelRoutes.dispose()
  }, 'dsh-sidechat: model route client')

  const annotationCore = observeAnnotationCore(ctx, [
    'embedded-composer-v1',
    'embedded-conversation-node-v1',
    'answer-link-v1',
  ])
  ctx.effect(
    () => ctx.betterSidebar.registerTab({
      id: SIDE_TAB_TYPE,
      title: () => t('menuTitle'),
      icon: (size: number) => <IconNewChatOutline16 size={size} />,
      order: 60,
      available: (availableCtx, scope) => canForkFrom(availableCtx, scope.sessionId),
      createTab: (state) => ({
        tab: { id: mintSideTabId(), type: SIDE_TAB_TYPE, title: sideTabTitle(collectSideTabs(state).map(tab => tab.title)) },
      }),
      onClose: (tab) => {
        releaseSideChatSession(tab.id)
        void annotationSafetyGuard.closeTab(tab.id)
      },
      component: (props) => (
        <SideChatPanel
          {...props}
          annotationCore={annotationCore}
          modelCoordinator={modelCoordinator}
          runtime={ctx}
        />
      ),
    }),
    'dsh-sidechat: side chat tab',
  )
  registerSideCommand(ctx)
}
