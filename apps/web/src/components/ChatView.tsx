import { useEffect, useRef } from 'react'
import type { ChatItem, StreamState } from '../state/stream-reducer'
import { MessageItem, TypingIndicator } from './MessageItem'
import { PermissionPrompt, type PermissionChatItem, type PermissionDecision } from './PermissionPrompt'
import { ToolCallItem, type ToolChatItem } from './ToolCallItem'

export type ChatViewProps = {
  items: ChatItem[]
  status: StreamState['status']
  onOpenInIde: (file: string, line?: number) => void
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void
}

/**
 * Mockup nesting: tool rows render inside the column of the assistant message
 * that produced them, so the flat ChatItem[] is folded into visual blocks.
 */
type Block =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; streaming: boolean; tools: ToolChatItem[] }
  | { type: 'permission'; item: PermissionChatItem }

function toBlocks(items: ChatItem[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        blocks.push({ type: 'user', text: item.text })
        break
      case 'assistant':
        blocks.push({ type: 'assistant', text: item.text, streaming: item.streaming, tools: [] })
        break
      case 'tool': {
        const last = blocks.at(-1)
        if (last !== undefined && last.type === 'assistant') last.tools.push(item)
        else blocks.push({ type: 'assistant', text: '', streaming: false, tools: [item] })
        break
      }
      case 'permission':
        blocks.push({ type: 'permission', item })
        break
    }
  }
  return blocks
}

/** How close to the bottom (px) still counts as "pinned" — trackpad slack. */
const PIN_THRESHOLD_PX = 48

export function ChatView({ items, status, onOpenInIde, onPermissionDecision }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow-the-stream pin. Only a user scroll can unpin (see onScroll): while
  // unpinned, new deltas must NOT yank the view back down — the user is
  // reading. A ref (not state): scroll position is imperative, no re-render.
  const pinnedRef = useRef(true)

  const onScroll = () => {
    const el = scrollRef.current
    if (el !== null) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    // No overflow (fresh or emptied session) — re-arm the pin so the next
    // session's history opens at the bottom even if the user had scrolled up.
    if (el.scrollHeight <= el.clientHeight) pinnedRef.current = true
    if (pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [items])

  const blocks = toBlocks(items)
  const last = items.at(-1)
  // Typing indicator: streaming but no text flowing yet (turn start, or the
  // text run was closed by a tool call). An unresolved permission blocks the
  // turn — showing "typing" there would lie.
  const showTyping =
    status === 'streaming' &&
    !(last?.kind === 'assistant' && last.streaming) &&
    !(last?.kind === 'permission' && last.resolved === undefined)
  const typingInLastBlock = showTyping && blocks.at(-1)?.type === 'assistant'

  return (
    <div className="messages" ref={scrollRef} onScroll={onScroll}>
      {blocks.map((block, index) => {
        const isLast = index === blocks.length - 1
        switch (block.type) {
          case 'user':
            return <MessageItem key={index} role="user" text={block.text} />
          case 'assistant':
            return (
              <MessageItem key={index} role="assistant" text={block.text}>
                {block.tools.map((tool) => (
                  <ToolCallItem key={tool.toolUseId} item={tool} onOpenInIde={onOpenInIde} />
                ))}
                {isLast && typingInLastBlock && <TypingIndicator />}
              </MessageItem>
            )
          case 'permission': {
            const { item } = block
            return (
              <PermissionPrompt
                key={item.requestId}
                item={item}
                onDecision={(decision) => onPermissionDecision(item.requestId, decision)}
              />
            )
          }
        }
      })}
      {showTyping && !typingInLastBlock && (
        <MessageItem role="assistant" text="">
          <TypingIndicator />
        </MessageItem>
      )}
    </div>
  )
}
