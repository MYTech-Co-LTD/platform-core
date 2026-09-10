import { Card, Result } from 'antd'

/** / 与 /console 占位页——console 壳在 Task 18 实现 */
export default function ConsolePlaceholder() {
  return (
    <Card style={{ maxWidth: 480, margin: '14vh auto' }}>
      <Result status="info" title="工作台建设中" subTitle="控制台即将上线" />
    </Card>
  )
}
