// src/kanban/kanban.gateway.ts
import {
  WebSocketGateway, WebSocketServer,
  SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

interface PresenceUser {
  userId: string;
  boardId: string;
  tenantId: string;
  name?: string;
  email?: string;
}

@WebSocketGateway({ namespace: '/kanban-rt', cors: { origin: '*' } })
export class KanbanGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  // clientId -> PresenceUser (for disconnect cleanup)
  private readonly clientBoards = new Map<string, PresenceUser>();

  // clientId -> { cardId, boardId, tenantId, field }
  private readonly clientEditing = new Map<string, { cardId: string; boardId: string; tenantId: string; field: string }>();

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) { client.disconnect(); return; }
    try {
      const payload = this.jwtService.verify<{ tenantId: string; id: string }>(token);
      client.data.tenantId = payload.tenantId;
      client.data.userId = payload.id;
      // Store display info passed by the frontend in handshake auth
      client.data.name = (client.handshake.auth?.name as string | undefined) ?? undefined;
      client.data.email = (client.handshake.auth?.email as string | undefined) ?? undefined;
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const presence = this.clientBoards.get(client.id);
    if (presence) {
      this.clientBoards.delete(client.id);
      this._broadcastPresence(presence.tenantId, presence.boardId);
    }
    const editing = this.clientEditing.get(client.id);
    if (editing) {
      this.clientEditing.delete(client.id);
      client.to(`${editing.tenantId}:board:${editing.boardId}`).emit('card:editing:stop', {
        cardId: editing.cardId,
        userId: client.data.userId,
        field: editing.field,
      });
    }
  }

  @SubscribeMessage('joinBoard')
  handleJoinBoard(client: Socket, payload: { boardId: string }) {
    const { tenantId, userId, name, email } = client.data as { tenantId: string; userId: string; name?: string; email?: string };
    client.join(`${tenantId}:board:${payload.boardId}`);
    this.clientBoards.set(client.id, { userId, boardId: payload.boardId, tenantId, name, email });
    this._broadcastPresence(tenantId, payload.boardId);
    return { joined: true };
  }

  @SubscribeMessage('leaveBoard')
  handleLeaveBoard(client: Socket, payload: { boardId: string }) {
    const { tenantId } = client.data as { tenantId: string };
    client.leave(`${tenantId}:board:${payload.boardId}`);
    this.clientBoards.delete(client.id);
    this._broadcastPresence(tenantId, payload.boardId);
  }

  @SubscribeMessage('card:editing')
  handleCardEditing(client: Socket, payload: { cardId: string; boardId: string; field: string }) {
    const { tenantId, userId } = client.data as { tenantId: string; userId: string };
    this.clientEditing.set(client.id, { cardId: payload.cardId, boardId: payload.boardId, tenantId, field: payload.field });
    client.to(`${tenantId}:board:${payload.boardId}`).emit('card:editing', {
      cardId: payload.cardId,
      userId,
      field: payload.field,
    });
  }

  @SubscribeMessage('card:editing:stop')
  handleCardEditingStop(client: Socket, payload: { cardId: string; boardId: string; field: string }) {
    const { tenantId, userId } = client.data as { tenantId: string; userId: string };
    this.clientEditing.delete(client.id);
    client.to(`${tenantId}:board:${payload.boardId}`).emit('card:editing:stop', {
      cardId: payload.cardId,
      userId,
      field: payload.field,
    });
  }

  private _broadcastPresence(tenantId: string, boardId: string) {
    const users: { userId: string; name?: string; email?: string }[] = [];
    const seen = new Set<string>();
    for (const p of this.clientBoards.values()) {
      if (p.tenantId === tenantId && p.boardId === boardId && !seen.has(p.userId)) {
        seen.add(p.userId);
        users.push({ userId: p.userId, name: p.name, email: p.email });
      }
    }
    this.server.to(`${tenantId}:board:${boardId}`).emit('board:presence', { users });
  }

  emit(tenantId: string, boardId: string, event: string, data: unknown) {
    this.server.to(`${tenantId}:board:${boardId}`).emit(event, data);
  }
}
