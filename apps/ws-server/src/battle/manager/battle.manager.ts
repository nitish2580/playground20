// import { WebSocket, WebSocketServer } from "ws";
// import { broadcastToRoom } from "../../utils/broadcast";
// import { redis } from "@repo/redis";
// import { GameState, GameMode, RoomSettings } from "../types";
import { battleLogger } from "@repo/logger";
import { redis, RedisKeys } from "@repo/redis"
import { WebSocketServer, WebSocket } from "ws";
import { RoomManager } from "@repo/room-manager";
import { GameMode, GameState, MessageType, Question } from "@repo/types";
import { PrismaClient } from "@repo/db";
const prisma = new PrismaClient();


export class BattleManager {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private questionStartTime = new Map<string, number>();
    constructor(private wss: WebSocketServer,
        private roomManager: RoomManager
    ) { }

    /**
 * Start the battle in a room
 */
    async startBattle(roomId: string): Promise<void> {
        try{
            console.log("🚀 ~ BattleManager ~ startBattle ~ roomId:", roomId)
            await redis.hset(`room:${roomId}:meta`, "status", "playing");
            await redis.hsetAll(`game:${roomId}:meta`, { state: GameState.WAITING, round: "1" });

            // Update in database
            await prisma.room.update({
                where: { id: roomId },
                data: {
                    status: "ACTIVE"
                }
            });

            this.broadcast(roomId, {
                type: MessageType.START,
                payload: { message: "Battle starting!" }
            });


            // Wait for players to get ready
            this.timers.set(roomId, setTimeout(() => this.startRound(roomId, 1), 5000));
        } catch(error) {
            console.error(error);
        }
    }

    /**
     * Stat the Round
     */

    async startRound(roomId: string, round: number): Promise<void> {
        const roomSettings = await this.roomManager.getRoomSettings(roomId);
        const questionCount = roomSettings.questionsPerRound || 3;

        this.broadcast(roomId, {
            type: MessageType.ROUND_START,
            payload: { round, message: `Round ${round} begins!` }
        });

        await redis.hsetAll(`game:${roomId}:meta`, {
            questionIndex: "1",
            questionsPerRound: questionCount.toString(),
        })

        // Start first question of this round
        this.startQuestion(roomId, round, 1);
    }

    /**
     * Start the question
     */

    async startQuestion(roomId: string, round: number, questionIndex: number): Promise<void> {
        try{
            const roomSettings = await this.roomManager.getRoomSettings(roomId);
            const totalQuestionsInRound = roomSettings.questionsPerRound || 3;
            console.log("🚀 ~ BattleManager ~ startQuestion ~ totalQuestionsInRound:", totalQuestionsInRound)
            //   questionsPerRound
            //   initialDifficulty
            //   difficultyProgression

            if (questionIndex > totalQuestionsInRound) {
                return;
            }

            // Check if game should end
            if (round > roomSettings.roundLimit) {
                await this.endGame(roomId);
                return;
            }

            const difficulty = await this.getTargetDifficulty(roomId, round, roomSettings.gameMode);
            console.log("🚀 ~ BattleManager ~ startQuestion ~ difficulty:", difficulty)
            const question = await this.getQuestion(difficulty);
            console.log("🚀 ~ BattleManager ~ startQuestion ~ question:", question)

            if (!question) {
                console.log("🚀 ~ when not question", question)
                await this.endGame(roomId, 'No more questions available');
                return;
            }

            const startTime = Date.now();
            console.log("🚀 ~ BattleManager ~ startQuestion ~ startTime:", startTime)
            // 🧠 Store game meta in Redis
            await redis.hsetAll(`game:${roomId}:meta`, {
                round: round.toString(),
                state: GameState.QUESTION,
                questionIndex: questionIndex.toString(),
                questionId: question.id,
                correctOption: question.correctOption,
                questionStartTime: startTime.toString(),
            });

            // Store question and start timer
            // await this.setGameState(roomId, GameState.QUESTION);
            // await this.setCurrentQuestionId(roomId, question.id);
            // await this.setQuestionStartTime(roomId, Date.now());

            // this.currentQuestionId.set(roomId, question.id);
            // this.questionStartTime.set(roomId, Date.now());
            const questionToBroadcast = {
                text: question?.text,
                options: question?.options,
            }
            console.log("🚀 ~ BattleManager ~ startQuestion ~ questionToBroadcast:", questionToBroadcast)

            this.broadcast(roomId, {
                type: MessageType.QUESTION,
                payload: {
                    question: questionToBroadcast,
                    startTime: Date.now(),
                    round,
                    totalRounds: roomSettings.roundLimit
                }
            });

            // Set timeout for question
            this.timers.set(
                roomId,
                setTimeout(() => this.endQuestion(roomId, round, questionIndex), roomSettings.timePerQuestion * 1000)
            );
        }
        // const round = parseInt((await redis.get(`game:${roomId}:round`)) || "1");
        catch(error) {
            console.error(error);
        }
    }

    async endQuestion(roomId: string, round: number, questionIndex: number): Promise<void> {
        const roomSettings = await this.roomManager.getRoomSettings(roomId);
        const totalQuestionsInRound = roomSettings.questionsPerRound || 3;

        this.broadcast(roomId, {
            type: MessageType.END_QUESTION,
            payload: {
                round,
                questionIndex,
                message: `Question ${questionIndex} ended.`,
            },
        })

        if (questionIndex < totalQuestionsInRound) {
            const nextIndex = questionIndex + 1;
            this.timers.set(
                roomId,
                setTimeout(() => this.startQuestion(roomId, round, nextIndex), 3000)
            ); // 3s gap
        } else {
            // Round finished
            this.endRound(roomId, round, questionIndex);
        }
    }

    async endRound(roomId: string, round: number, questionIndex: number): Promise<void> {
        const roomSettings = await this.roomManager.getRoomSettings(roomId);
        const totalRounds = roomSettings.roundLimit || 3;

        this.broadcast(roomId, {
            type: MessageType.ROUND_END,
            payload: { round, message: `Round ${round} completed!` },
        });

        if (round < totalRounds) {
            const nextRound = round + 1;
            await redis.set(`game:${roomId}:round`, nextRound.toString());
            this.timers.set(roomId, setTimeout(() => this.startRound(roomId, nextRound), 5000));
        } else {
            this.endGame(roomId);
        }
    }

    async endGame(roomId: string, reason?: string): Promise<void> {
        this.clearTimer(roomId);
        await redis.hset(`room:${roomId}:meta`, "status", "ended");
        await prisma.room.update({ where: { id: roomId }, data: { status: "ENDED" } });

        this.broadcast(roomId, {
            type: MessageType.END,
            payload: { message: reason || "Game Over!" },
        });
    }

    private clearTimer(roomId: string) {
        const timer = this.timers.get(roomId);
        if (timer) clearTimeout(timer);
        this.timers.delete(roomId);
    }

    private async getRoomMode(roomId: string): Promise<string> {
        return ""
    }

    async handleAnswer(roomId: string, userId: string, selectedOption: string) {
        const roomSettings = await this.roomManager.getRoomSettings(roomId);
        const state = await redis.get(`game:${roomId}:state`);
        if (state !== GameState.QUESTION) return;

        const gameMetaData: {questionId: string, round: string, correctOption: string} = await redis.hgetall(`game:${roomId}:meta`)
        if (!gameMetaData?.questionId) return;

        const questionStart = this.questionStartTime.get(roomId) || Date.now();
        const serverTime = Date.now();
        const timeTakenMs = serverTime - questionStart;


        const isCorrect = gameMetaData.correctOption === selectedOption;

        if (isCorrect) {
            const baseScore = 1000 - (timeTakenMs / 45000) * 900;
            const difficulty = await this.getTargetDifficulty(
                roomId,
                parseInt(gameMetaData?.round || "1"),
                roomSettings?.gameMode,
            );
            const finalScore = Math.max(100, Math.floor(baseScore * (1 + (difficulty - 1) * 0.25)));

            await redis.zincrby(`game:${roomId}:scores`, finalScore, userId);
            await redis.hset(`game:${roomId}:answers`, userId, timeTakenMs.toString());
        }

        // Record answer in DB (would be an API call in production)
        battleLogger.debug('Answer recorded', {
            userId,
            roomId,
            questionId: gameMetaData?.questionId,
            isCorrect,
            timeTakenMs
        });
    }

    // async handleAnswer(
    //     roomId: string,
    //     userId: string,
    //     selectedOption: string
    // ) {
    //     const startTime = this.questionStartTime.get(roomId);
    //     if (!startTime) return;

    //     const timeTakenMs = Date.now() - startTime;

    //     // 1. Update Redis state IMMEDIATELY (sub-millisecond)
    //     await this.updateRedisState(roomId, userId, selectedOption, timeTakenMs);

    //     // 2. Queue DB update (non-blocking)
    //     await redis.lpush('db-queue', JSON.stringify({
    //         type: 'ANSWER',
    //         data: {
    //             roomId,
    //             userId,
    //             selectedOption,
    //             timeTakenMs,
    //             timestamp: Date.now()
    //         }
    //     }));

    //     // 3. Respond to player immediately (no DB wait)
    //     this.broadcast(roomId, {
    //         type: MessageType.ANSWER_CONFIRMED,
    //         payload: { timeTakenMs }
    //     });
    // }

    /**
   * Get target difficulty based on game mode and round
   */
    private async getTargetDifficulty(
        roomId: string,
        round: number,
        mode: GameMode
    ): Promise<number> {
        console.log("🚀 ~ BattleManager ~ getTargetDifficulty ~ mode:", mode)
        console.log("🚀 ~ BattleManager ~ getTargetDifficulty ~ round:", round)
        console.log("🚀 ~ BattleManager ~ getTargetDifficulty ~ roomId:", roomId)
        const settings = await this.roomManager.getRoomSettings(roomId);
        console.log("🚀 ~ BattleManager ~ getTargetDifficulty ~ settings:", settings)
        if (mode !== GameMode.BATTLE_ROYALE) {
            return settings.initialDifficulty || 1
        }

        const baseDifficulty = settings.initialDifficulty || 1;
        const increment = settings.difficultyIncrement || 1;
        console.log("🚀 ~ BattleManager ~ getTargetDifficulty ~ increment:", increment)

        return Math.min(
            baseDifficulty + (round - 1) * increment,
            settings.maxDifficulty || 5
        );
    }


    /**
   * Get a question of the specified difficulty
   */
    private async getQuestion(difficulty: number): Promise<Question | null> {
        try{
            const question = await prisma.question.findFirst({
                where: {
                    baseDifficulty: this.mapDifficultyToEnum(difficulty),
                    approved: true
                },
                orderBy: {
                    usedCount: 'asc'
                }
            });  
            console.log("🚀 ~ BattleManager ~ getQuestion ~ question:", question)

            if (!question) return null;
            console.log("🚀 ~ when question is null: ", question)
            console.log("🚀 ~ when question is null: type of the options ",typeof question?.options)

            // Update usage count
            await prisma.question.update({
                where: { id: question.id },
                data: {
                    usedCount: { increment: 1 },
                    lastUsedAt: new Date()
                }
            });

            return {
                id: question.id,
                text: question.text,
                options: typeof question.options === "string" ? JSON.parse(question.options as string) : question.options,
                correctOption: question.correctOption,
                difficulty
            };
        } catch(error) {
            console.error(error);
            return null;
        }
        // In a real implementation, this would query the database

    }


    /**
 * Map numeric difficulty to Prisma enum
 */
    private mapDifficultyToEnum(difficulty: number): 'EASY' | 'MEDIUM' | 'HARD' | 'EXPERT' | 'MASTER' {
        if (difficulty <= 1) return 'EASY';
        if (difficulty <= 2) return 'MEDIUM';
        if (difficulty <= 3) return 'HARD';
        if (difficulty <= 4) return 'EXPERT';
        return 'MASTER';
    }

    /**
     * Map prisma enum to numeric
     */

    private mapEnumToDifficulty(difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'EXPERT' | 'MASTER'): number {
        if (difficulty === 'EASY') return 1;
        if (difficulty === 'MEDIUM') return 2;
        if (difficulty === 'HARD') return 3;
        if (difficulty === 'EXPERT') return 4;
        return 5
    }


    /**
     * Broadcasting the message to the room
     */

    public broadcast(roomId: string, data: any) {
        this.wss.clients.forEach((client: WebSocket & { roomId?: string }) => {
            if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
                client.send(JSON.stringify(data));
            }
        });
    }
}

// export class BattleManager {
//     private timers = new Map<string, NodeJS.Timeout>();
//     private currentQuestionId = new Map<string, string>();
//     private questionStartTime = new Map<string, number>();

//     constructor(
//         private wss: WebSocketServer
//     ) { }

//     async handleConnection(ws: WebSocket & { userId?: string; roomId?: string }) {
//         if (!ws.userId) {
//             return;
//         }

//         try {
//             // Join a room using the proper method
//             const { roomId, mode } = await this.joinUserToRoom(ws.userId);
//             ws.roomId = roomId;

//             // Store room ID on WebSocket
//             (ws as any).roomId = roomId;

//             // Initialize battle based on mode
//             await this.initializeRoom(roomId, mode);

//             battleLogger.info('User joined room', {
//                 userId: ws.userId,
//                 roomId,
//                 mode
//             });

//         } catch (error) {
//             battleLogger.error('Failed to handle connection', {
//                 userId: ws.userId,
//                 error: (error as Error).message
//             });
//             ws.close(4000, 'Failed to join room');
//         }
//     }

//     /**
//      * Join user to a room (public or private)
//      */
//     private async joinUserToRoom(userId: string): Promise<{ roomId: string; mode: GameMode }> {
//         // Get available public rooms
//         const publicRooms = await redis.getJson<string[]>('public_rooms:available') || [];

//         let roomId: string;
//         let mode: GameMode;

//         // Try to join an existing room with available slots
//         let joinedRoom = false;

//         for (const room of publicRooms) {
//             const playerCount = await redis.scard(`room:${room}:members`);
//             const maxPlayers = await redis.hget(`room:${room}:meta`, 'maxPlayers');

//             if (playerCount < parseInt(maxPlayers || '20')) {
//                 roomId = room;
//                 mode = (await redis.hget(`room:${room}:meta`, 'mode')) as GameMode || GameMode.CLASSIC;
//                 joinedRoom = true;
//                 break;
//             }
//         }

//         // If no room available, create a new one
//         if (!joinedRoom) {
//             roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
//             mode = GameMode.CLASSIC; // Default mode

//             // Create room metadata
//             await redis.setJson(`room:${roomId}:meta`, {
//                 type: "public",
//                 mode: mode,
//                 status: "waiting",
//                 hostId: userId,
//                 maxPlayers: 20
//             });

//             // Add to public rooms list
//             await redis.setJson('public_rooms:available', [...publicRooms, roomId]);
//         }

//         // Add user to room
//         await redis.sadd(`room:${roomId}:members`, userId);
//         await redis.hset(`room:${roomId}:status`, userId, "active");

//         return { roomId, mode };
//     }

//     private async initializeRoom(roomId: string, mode: GameMode) {
//         // Check if room has enough players to start
//         const playerCount = await redis.scard(`room:${roomId}:members`);

//         if (playerCount >= 2) {
//             await this.startGame(roomId);
//         } else {
//             // Update room state
//             await redis.hset(`room:${roomId}:meta`, "status", "waiting");

//             // Notify users that we're waiting for more players
//             broadcastToRoom(this.wss, roomId, {
//                 type: "state",
//                 state: GameState.WAITING,
//                 playerCount
//             });
//         }
//     }

//     private async startGame(roomId: string) {
//         await redis.setJson(`room:${roomId}:meta`, {
//             ...(await redis.getJson(`room:${roomId}:meta`)),
//             status: "active"
//         });

//         await redis.set(`game:${roomId}:state`, GameState.WAITING);
//         await redis.set(`game:${roomId}:round`, 1);
//         await redis.delete(`game:${roomId}:scores`);

//         const playerCount = await redis.scard(`room:${roomId}:members`);

//         broadcastToRoom(this.wss, roomId, {
//             type: "state",
//             state: GameState.WAITING,
//             playerCount
//         });

//         this.timers.set(
//             roomId,
//             setTimeout(() => this.startRound(roomId), 5000)
//         );
//     }

//     private async startRound(roomId: string) {
//         const round = parseInt(await redis.get(`game:${roomId}:round`));
//         const settings = await this.getRoomSettings(roomId);

//         await redis.set(`game:${roomId}:state`, GameState.QUESTION);
//         await redis.set(`game:${roomId}:questionStart`, Date.now());
//         await redis.delete(`game:${roomId}:answers`);

//         const difficulty = await this.getTargetDifficulty(roomId, round, settings.mode);
//         const question = await this.getQuestion(difficulty);

//         this.currentQuestionId.set(roomId, question.id);
//         this.questionStartTime.set(roomId, Date.now());

//         broadcastToRoom(this.wss, roomId, {
//             type: "question",
//             question,
//             round,
//             timeLimit: settings.timePerQuestion * 1000
//         });

//         this.timers.set(
//             roomId,
//             setTimeout(() => this.endRound(roomId), settings.timePerQuestion * 1000)
//         );
//     }

//     private async getTargetDifficulty(
//         roomId: string,
//         round: number,
//         mode: GameMode
//     ): Promise<number> {
//         // For Battle Royale, difficulty increases each round
//         if (mode === GameMode.BATTLE_ROYALE) {
//             const settings = await this.getRoomSettings(roomId);
//             return Math.min(5, 1 + Math.floor((round - 1) * (settings.difficultyIncrement || 1)));
//         }

//         // For Classic mode, check individual preferences
//         const activePlayers = await redis.smembers(`room:${roomId}:members`);
//         const preferences = await Promise.all(
//             activePlayers.map(player =>
//                 redis.hget(`room:${roomId}:player:${player}`, 'difficultyPreference')
//             )
//         );

//         const wantsProgression = preferences.some(p => p === 'true');
//         if (!wantsProgression) return 1;

//         const settings = await this.getRoomSettings(roomId);
//         return Math.min(
//             settings.maxDifficulty || 5,
//             settings.initialDifficulty + Math.floor((round - 1) / 3)
//         );
//     }

//     async handleMessage(
//         ws: WebSocket & { userId?: string; roomId?: string },
//         WebSocket.Data
//     ) {
//         if (!ws.userId || !ws.roomId) {
//             return;
//         }

//         try {
//             const message = JSON.parse(data.toString());

//             switch (message.type) {
//                 case "answer":
//                     await this.handleAnswer(ws.roomId, ws.userId, message.selectedOption);
//                     break;

//                 case "ready":
//                     await this.handleReady(ws.roomId, ws.userId);
//                     break;

//                 case "leave":
//                     await this.handleLeave(ws.roomId, ws.userId);
//                     break;

//                 default:
//                     battleLogger.warn('Unknown message type', {
//                         type: message.type,
//                         userId: ws.userId
//                     });
//             }
//         } catch (error) {
//             battleLogger.error('Failed to handle message', {
//                 userId: ws.userId,
//                 error: (error as Error).message
//             });
//         }
//     }

    // private async handleAnswer(roomId: string, userId: string, selectedOption: string) {
    //     const state = await redis.get(`game:${roomId}:state`);
    //     if (state !== GameState.QUESTION) return;

    //     const questionId = this.currentQuestionId.get(roomId);
    //     if (!questionId) return;

    //     const questionStart = this.questionStartTime.get(roomId) || Date.now();
    //     const serverTime = Date.now();
    //     const timeTakenMs = serverTime - questionStart;

    //     const question = await this.getQuestionById(questionId);
    //     const isCorrect = question.correctOption === selectedOption;

    //     if (isCorrect) {
    //         const baseScore = 1000 - (timeTakenMs / 45000) * 900;
    //         const difficulty = await this.getTargetDifficulty(
    //             roomId,
    //             parseInt(await redis.get(`game:${roomId}:round`)),
    //             await this.getRoomMode(roomId)
    //         );
    //         const finalScore = Math.max(100, Math.floor(baseScore * (1 + (difficulty - 1) * 0.25)));

    //         await redis.zincrby(`game:${roomId}:scores`, finalScore, userId);
    //         await redis.hset(`game:${roomId}:answers`, userId, timeTakenMs);
    //     }

    //     // Record answer in DB (would be an API call in production)
    //     battleLogger.debug('Answer recorded', {
    //         userId,
    //         roomId,
    //         questionId,
    //         isCorrect,
    //         timeTakenMs
    //     });
    // }

//     private async handleReady(roomId: string, userId: string) {
//         await redis.hset(`room:${roomId}:status`, userId, "ready");

//         // Check if all players are ready
//         const playerCount = await redis.scard(`room:${roomId}:members`);
//         const readyCount = await redis.hlen(`room:${roomId}:status`);

//         if (playerCount >= 2 && readyCount >= 2) {
//             // Start the game
//             await this.startGame(roomId);
//         }
//     }

//     private async handleLeave(roomId: string, userId: string) {
//         // Remove user from room
//         await redis.srem(`room:${roomId}:members`, userId);
//         await redis.hdel(`room:${roomId}:status`, userId);

//         broadcastToRoom(this.wss, roomId, {
//             type: "player_left",
//             userId
//         });

//         // Check if room should end
//         const playerCount = await redis.scard(`room:${roomId}:members`);
//         if (playerCount < 2) {
//             await this.endGame(roomId);
//         }
//     }

//     private async endRound(roomId: string) {
//         const mode = await this.getRoomMode(roomId);

//         await redis.set(`game:${roomId}:state`, GameState.RESULTS);

//         const [answers, scores] = await Promise.all([
//             redis.hgetall(`game:${roomId}:answers`),
//             redis.zrange(`game:${roomId}:scores`, 0, -1, 'WITHSCORES')
//         ]);

//         const results = Object.entries(answers).map(([userId, time]) => ({
//             userId,
//             time: parseInt(time),
//             score: parseInt(scores[scores.indexOf(userId) + 1] || "0")
//         }));

//         broadcastToRoom(this.wss, roomId, {
//             type: "results",
//             results: results.sort((a, b) => a.time - b.time)
//         });

//         if (mode === GameMode.BATTLE_ROYALE) {
//             await this.handleBattleRoyaleElimination(roomId);
//         }

//         const playerCount = await redis.scard(`room:${roomId}:members`);
//         if (playerCount < 2) {
//             await this.endGame(roomId);
//             return;
//         }

//         this.timers.set(
//             roomId,
//             setTimeout(async () => {
//                 await redis.incr(`game:${roomId}:round`);
//                 this.startRound(roomId);
//             }, 5000)
//         );
//     }

//     private async handleBattleRoyaleElimination(roomId: string) {
//         const settings = await this.getRoomSettings(roomId);
//         const answers = await redis.hgetall(`game:${roomId}:answers`);

//         const answerEntries = Object.entries(answers)
//             .map(([userId, time]) => ({
//                 userId,
//                 time: parseInt(time)
//             }))
//             .sort((a, b) => b.time - a.time); // Slowest first

//         // Eliminate the slowest incorrect answers, then slowest correct
//         const toEliminate = answerEntries
//             .slice(0, settings.eliminationCount || 1)
//             .map(entry => entry.userId);

//         for (const userId of toEliminate) {
//             await redis.srem(`room:${roomId}:members`, userId);
//             await redis.hset(`room:${roomId}:status`, userId, 'eliminated');
//             await redis.hset(`room:${roomId}:eliminatedAt`, userId, Date.now());
//             await redis.hset(`room:${roomId}:eliminationRound`, userId,
//                 await redis.get(`game:${roomId}:round`));
//         }

//         // Broadcast elimination
//         broadcastToRoom(this.wss, roomId, {
//             type: "eliminated",
//             userIds: toEliminate
//         });
//     }

//     private async endGame(roomId: string) {
//         const winner = await redis.zrevrange(`game:${roomId}:scores`, 0, 0);

//         await redis.setJson(`room:${roomId}:meta`, {
//             ...(await redis.getJson(`room:${roomId}:meta`)),
//             status: "ended"
//         });

//         await redis.delete(`game:${roomId}:*`);

//         broadcastToRoom(this.wss, roomId, {
//             type: "end",
//             winner: winner[0],
//             finalScores: await this.getFinalScores(roomId)
//         });

//         // Cleanup
//         this.clearRoomTimers(roomId);

//         battleLogger.info('Game ended', {
//             roomId,
//             winner: winner[0]
//         });
//     }

//     private async getFinalScores(roomId: string) {
//         const scores = await redis.zrange(`game:${roomId}:scores`, 0, -1, 'WITHSCORES');
//         return Object.fromEntries(
//             Array(scores.length / 2)
//                 .fill(0)
//                 .map((_, i) => [scores[i * 2], parseInt(scores[i * 2 + 1])])
//         );
//     }

//     private async getRoomSettings(roomId: string): Promise<RoomSettings> {
//         const meta = await redis.getJson<Partial<RoomSettings>>(`room:${roomId}:meta`);

//         return {
//             mode: meta.mode || GameMode.CLASSIC,
//             questionLimit: meta.questionLimit || 20,
//             timePerQuestion: meta.timePerQuestion || 45,
//             difficultyProgression: meta.difficultyProgression ?? true,
//             initialDifficulty: meta.initialDifficulty || 1,
//             maxDifficulty: meta.maxDifficulty || 5,
//             eliminationCount: meta.eliminationCount || 1,
//             difficultyIncrement: meta.difficultyIncrement || 1
//         };
//     }

//     private async getRoomMode(roomId: string): Promise<GameMode> {
//         const meta = await redis.getJson<{ mode: GameMode }>(`room:${roomId}:meta`);
//         return meta?.mode || GameMode.CLASSIC;
//     }

//     private async getQuestion(difficulty: number): Promise<{
//         id: string;
//         text: string;
//         options: string[];
//         correctOption: string;
//         difficulty: number;
//     }> {
//         // In production, this would fetch from database
//         const questions = [
//             {
//                 id: "q1",
//                 text: "What is the capital of France?",
//                 options: ["Paris", "London", "Berlin", "Madrid"],
//                 correctOption: "Paris",
//                 difficulty: 1
//             },
//             {
//                 id: "q2",
//                 text: "Which planet is known as the Red Planet?",
//                 options: ["Earth", "Mars", "Jupiter", "Venus"],
//                 correctOption: "Mars",
//                 difficulty: 1
//             },
//             {
//                 id: "q3",
//                 text: "What is the largest ocean on Earth?",
//                 options: ["Atlantic", "Indian", "Arctic", "Pacific"],
//                 correctOption: "Pacific",
//                 difficulty: 2
//             }
//         ];

//         // Filter by difficulty and pick random
//         const available = questions.filter(q => q.difficulty <= difficulty);
//         return available[Math.floor(Math.random() * available.length)];
//     }

//     private async getQuestionById(questionId: string) {
//         // In production, this would fetch from database
//         return this.getQuestion(1); // Simplified
//     }

//     private clearRoomTimers(roomId: string) {
//         const timer = this.timers.get(roomId);
//         if (timer) {
//             clearTimeout(timer);
//             this.timers.delete(roomId);
//         }

//         this.currentQuestionId.delete(roomId);
//         this.questionStartTime.delete(roomId);
//     }

//     async handleDisconnect(ws: WebSocket & { userId?: string; roomId?: string }) {
//         if (!ws.userId || !ws.roomId) {
//             return;
//         }

//         battleLogger.info('User disconnected', {
//             userId: ws.userId,
//             roomId: ws.roomId
//         });

//         // Notify room of disconnect
//         broadcastToRoom(this.wss, ws.roomId, {
//             type: "player_left",
//             userId: ws.userId
//         });

//         // Update room state
//         await redis.srem(`room:${ws.roomId}:members`, ws.userId);
//         await redis.hdel(`room:${ws.roomId}:status`, ws.userId);

//         // Check if room should end
//         const playerCount = await redis.scard(`room:${ws.roomId}:members`);
//         if (playerCount < 2) {
//             await this.endGame(ws.roomId);
//         }
//     }
// }