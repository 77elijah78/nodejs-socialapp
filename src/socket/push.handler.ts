import { z } from 'zod';
import type { AuthenticatedSocket } from './index.js';
import { prisma } from '../config/database.js';
import { messageService } from '../services/message.service.js';
import { clearDeviceView, setDeviceView } from '../services/delivery-state.service.js';
import { logger } from '../config/logger.js';

export function registerPushHandlers(socket: AuthenticatedSocket) {
  const devices = new Set<string>();
  socket.on('conversation:visibility', async (payload: unknown, ack?: (value: object) => void) => {
    try {
      const input = z.object({ deviceId: z.string().uuid(), state: z.enum(['foreground', 'background']), conversationId: z.string().uuid().nullable().optional() }).parse(payload);
      const device = await prisma.pushDevice.findFirst({ where: { userId: socket.userId, deviceId: input.deviceId, enabled: true }, select: { id: true } });
      if (!device) throw new Error('Device is not registered to this account');
      if (input.state === 'foreground' && input.conversationId) {
        await messageService.requireMember(input.conversationId, socket.userId);
        await setDeviceView(device.id, socket.id, input.conversationId);
        devices.add(device.id);
      } else { await clearDeviceView(device.id, socket.id); }
      if (typeof ack === 'function') ack({ success: true, expiresInSeconds: 45 });
    } catch { if (typeof ack === 'function') ack({ success: false, error: 'Unable to update conversation visibility' }); }
  });
  socket.on('disconnect', () => {
    void Promise.all([...devices].map(id => clearDeviceView(id, socket.id)))
      .catch(() => logger.warn('Conversation visibility disconnect cleanup failed; leases will expire'));
  });
}
