
import { WebSocket, WebSocketServer } from "ws";
import { battleLogger, wsLogger } from "@repo/logger";
import { RoomManager } from "@repo/room-manager";
import { GameMode, MessageType, RoomType } from "@repo/types";
import { redis, RedisKeys } from "@repo/redis";
import { BattleManager } from "../battle/manager/battle.manager";
const roomManager = new RoomManager();


export async function handleMessage(
    ws: WebSocket & { userId?: string; roomId?: string },
    wss: WebSocketServer,
    message: any
) {
    wsLogger.info("function [handleMessage]", { userId: ws?.userId });
    if (!ws.userId) return;

    switch (message.type) {
        case MessageType.JOIN:
            await handleJoin(ws, wss, message.payload);
            break;
        case MessageType.READY:
            console.log("ready");
            await handleReady(ws, wss, message.payload);
            break;
        case MessageType.START:
            await handleStart(ws, wss);
            break;
        case MessageType.ANSWER:
            console.log("answer");
            await handleAnswer(ws, wss, message.payload);
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

const handleJoin = async (ws: WebSocket & { userId?: string; }, wss: WebSocketServer, payload: { roomId: string, inviteCode: string }) => {

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

    await roomManager.setPlayerReady(roomId, ws?.userId, true);

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

const handleReady = async (ws: WebSocket & { userId?: string; roomId?: string }, wss: WebSocketServer, payload: { isReady: boolean }) => {
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
    const roomSettings = await roomManager.getRoomSettings(ws.roomId);

    if (roomSettings.gameMode !== GameMode.BATTLE_ROYALE && allReady && playerCount >= 2) {
        await battleManager.startBattle(ws.roomId);
    }

}

/**
 * Handle Start the Battle
 */

const handleStart = async (ws: WebSocket & { userId?: string; roomId?: string }, wss: WebSocketServer) => {
    try {
        // Validate required data
        if (!ws.userId || !ws.roomId) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'User not authenticated'
            }));
            return;
        }

        // Check if all players are ready (your logic here)
        const areAllPlayersReady = await roomManager.areAllPlayersReady(ws?.roomId);
        const battleManager = new BattleManager(wss, roomManager);

        if (!areAllPlayersReady) {
            battleManager.broadcast(ws.roomId, {
                type: "error",
                message: 'Not all players are ready to start',
            })
            return;
        }

        await battleManager.startBattle(ws?.roomId);

        // If everything is OK, send success response
        ws.send(JSON.stringify({
            type: 'success',
            message: 'Game started successfully'
        }));

    } catch (error) {
        // Handle any unexpected errors
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Internal server error'
        }));
        wsLogger.error('Error handling message', {
            error: (error as Error).message,
            userId: ws.userId
        });
    }
}

const handleAnswer = async (ws: WebSocket & { userId?: string; roomId?: string }, wss: WebSocketServer, payload: { selectedOption: string }) => {
    if (!ws.userId || !ws.roomId) return;

    const { selectedOption } = payload;
    console.log("🚀 ~ handleAnswer ~ selectedOption:", selectedOption)
    const timestamp = Date.now();
    const { userId, roomId } = ws;

    const serverTime = Date.now();

    const playerKey = `game:${roomId}:answers`;

    const alreadyAnswered = await redis.hget(playerKey, userId);
    if (alreadyAnswered) {
        ws.send(JSON.stringify({
            type: 'answer_rejected',
            payload: { reason: 'Already answered' }
        }));
        return;
    }

    const gameMetaData: { correctOption?: String, questionStartTime: string } = await redis.hgetall(`game:${roomId}:meta`);
    const questionStartTime = new Date(Number(gameMetaData?.questionStartTime));
    const timeTakenMs = serverTime - questionStartTime.getTime();


    const isCorrect = gameMetaData?.correctOption === selectedOption;
    console.log("🚀 ~ handleAnswer ~ isCorrect:", isCorrect)

    if (isCorrect) {
        const baseScore = 1000 - (timeTakenMs / 45000) * 900;
        console.log("🚀 ~ handleAnswer ~ baseScore:", baseScore)

        // const roomSettings = await this.roomManager.getRoomSettings(roomId);
        let finalScore = Math.max(100, Math.floor(baseScore));

        // if (roomSettings.useDifficultyScoring) {
        //     const difficulty = await this.getTargetDifficulty(
        //         roomId,
        //         parseInt(await redis.get(`game:${roomId}:round`)),
        //         await this.getRoomMode(roomId)
        //     );
        //     finalScore = Math.max(100, Math.floor(baseScore * (1 + (difficulty - 1) * 0.25)));
        // }

        await redis.zincrby(`game:${roomId}:scores`, finalScore, userId);
        await redis.hset(playerKey, userId, timeTakenMs.toString());
    }

}

// const handleAnswer = async (ws: WebSocket & { userId?: string, roomId?: string }, wss: WebSocketServer) => {

// }

/**
 * Handle answer submission
 */



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