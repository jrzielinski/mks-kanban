import React from 'react';
import type { TuiMessageDTO } from '@shared/types';
import { BashLiveCard } from './tool-cards/BashLiveCard';
import { EditCard } from './tool-cards/EditCard';
import { WriteCard } from './tool-cards/WriteCard';
import { MultiEditCard } from './tool-cards/MultiEditCard';
import { ReadCard } from './tool-cards/ReadCard';
import { GrepCard } from './tool-cards/GrepCard';
import { GlobCard } from './tool-cards/GlobCard';
import { TodoWriteCard } from './tool-cards/TodoWriteCard';
import { GenericToolCard } from './tool-cards/GenericToolCard';

interface Props {
  message: TuiMessageDTO;
}

/**
 * Dispatcher por toolName. Aceita os apelidos legados (shell_run,
 * read_file, web_fetch) que ainda aparecem em mensagens antigas /
 * de providers que normalizam para snake_case.
 */
export const ToolCard = React.memo(function ToolCard({
  message,
}: Props): React.ReactElement {
  const name = message.toolName ?? '';

  switch (name) {
    case 'Bash':
    case 'shell_run':
      return <BashLiveCard message={message} />;
    case 'Edit':
      return <EditCard message={message} />;
    case 'Write':
      return <WriteCard message={message} />;
    case 'MultiEdit':
      return <MultiEditCard message={message} />;
    case 'Read':
    case 'read_file':
      return <ReadCard message={message} />;
    case 'Grep':
      return <GrepCard message={message} />;
    case 'Glob':
      return <GlobCard message={message} />;
    case 'TodoWrite':
      return <TodoWriteCard message={message} />;
    default:
      return <GenericToolCard message={message} />;
  }
});
