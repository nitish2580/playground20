
import { WebSocket, WebSocketServer } from "ws";
import { battleLogger, wsLogger } from "@repo/logger";
import { RoomManager } from "@repo/room-manager";
import { GameMode, RoomType } from "@repo/types";
import { redis, RedisKeys } from "@repo/redis";
import { BattleManager } from "@repo/battle-logic";
const roomManager = new RoomManager();


export async function handleMessage(
    ws: WebSocket & { userId?: string; roomId?: string },
    wss: WebSocketServer,
    message: any
) {
    wsLogger.info("function [handleMessage]", { userId: ws?.userId });
    if (!ws.userId) return;

    switch (message.type) {
        case "join":
            await handleJoin(ws, wss, message.payload);
            break;
        case "ready":
            console.log("ready");
            await handleReady(ws, wss, message.payload);
            break;
        case "answer":
            console.log("answer");
            // await battleManager.handleAnswer(
            //     ws.roomId!,
            //     ws.userId,
            //     message.payload.selectedOption
            // );
            break;
        default:
            battleLogger.warn("Unknown message type", {
                type: message.type,
                userId: ws.userId
            });
    }
}

/**
 * Handle rom join rquest
 */

const handleJoin = async (ws: WebSocket & { userId?: string; roomId?: string }, wss: WebSocketServer, payload: { roomId: string, inviteCode: string }) => {

    if (!ws.userId) {
        return;
    }

    const battleManager = new BattleManager(wss, roomManager);

    let roomId: string;

    if (payload?.roomId) {
        roomId = payload?.roomId
    } else {
        roomId = await roomManager.getPublicRoom(ws?.userId);
    }


    const resopnse = await roomManager.joinRoom(ws?.userId, roomId, payload?.inviteCode);
    ws.roomId = roomId;

    await roomManager.setPlayerReady(roomId, ws?.userId, false);

    const playerCount = await redis.scard(RedisKeys.room.members(roomId));
    const allReady = await roomManager.areAllPlayersReady(roomId);

    ws.send(JSON.stringify({
        type: "joined",
        payload: {
            roomId,
            playerCount,
            allReady,
            settings: await roomManager.getRoomSettings(roomId)
        }
    }));

    battleManager.broadcast(roomId, {
            userId: ws.userId,
            playerCount
        });

    battleLogger.info("User joined room", {
        userId: ws.userId,
        roomId,
        playerCount
    });
}

const handleReady = async (ws: WebSocket & { userId?: string; roomId?: string }, wss: WebSocketServer, payload: { roomId: string, isReady: boolean }) => {
    if (!ws.userId || !ws.roomId) {
        return;
    }

    const battleManager = new BattleManager(wss, roomManager);
    await roomManager.setPlayerReady(ws.roomId, ws.userId, true);
    const playerCount = await redis.scard(`room:${ws.roomId}:members`);
    const allReady = await roomManager.areAllPlayersReady(ws.roomId);

    battleManager.broadcast(ws.roomId, {
        type: "player_ready",
        payload: {
            userId: ws.userId,
            isReady: payload.isReady,
            allReady,
            playerCount
        }
    });

    if (allReady && playerCount >= 2) {
        await battleManager.startBattle(ws.roomId);
    }

}



/**
 * Handle room join request
 */
// async function handleJoin(
//     ws: WebSocket & { userId?: string; roomId?: string },
//     payload: { roomId?: string; inviteCode?: string }
// ) {
//     if (!ws.userId) return;

//     let roomId: string;

//     // Join specific room or find public room
//     if (payload.roomId) {
//         roomId = payload.roomId;
//     } else {
//         roomId = await roomManager.getPublicRoom();
//     }

//     // Join the room
//     await roomManager.joinRoom(ws.userId, roomId, payload.inviteCode);
//     ws.roomId = roomId;

//     // Set initial status to waiting
//     await roomManager.setPlayerReady(roomId, ws.userId, false);

//     // Send room state
//     const playerCount = await RedisClient.getInstance().scard(`room:${roomId}:members`);
//     const allReady = await roomManager.areAllPlayersReady(roomId);

// ws.send(JSON.stringify({
//     type: "joined",
//     payload: {
//         roomId,
//         playerCount,
//         allReady,
//         settings: await roomManager.getRoomSettings(roomId)
//     }
// }));

//     // Broadcast new player joined
    // battleManager.broadcast(roomId, {
    //     type: "player_joined",
    //     payload: {
    //         userId: ws.userId,
    //         playerCount
    //     }
    // });

//     battleLogger.info("User joined room", {
//         userId: ws.userId,
//         roomId,
//         playerCount
//     });
// }