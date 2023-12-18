import { Connection, IPacketResponse, Socket } from '@senfo/battleye';
import { Manager } from '../control/manager';
import * as dgram from 'dgram';
import * as path from 'path';
import { LogLevel } from '../util/logger';
import { RconBan, RconPlayer } from '../types/rcon';
import { IStatefulService } from '../types/service';
import { ServerState } from '../types/monitor';
import { matchRegex } from '../util/match-regex';
import { inject, injectable, registry, singleton } from 'tsyringe';
import { LoggerFactory } from './loggerfactory';
import { FSAPI, InjectionTokens, RCONSOCKETFACTORY } from '../util/apis';
import { EventBus } from '../control/event-bus';
import { InternalEventTypes } from '../types/events';
import { Listener } from 'eventemitter2';

export class BattleyeConf {

    public constructor(
        // eslint-disable-next-line @typescript-eslint/naming-convention
        public RConPassword: string,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        public RestrictRCon: string,
    ) {}

}

@singleton()
@registry([{
    token: InjectionTokens.rconSocket,
    useFactory: /* istanbul ignore next */ () => /* istanbul ignore next */ () => new Socket(),
}]) // eslint-disable-line @typescript-eslint/indent
@injectable()
export class RCON extends IStatefulService {

    private readonly RND_RCON_PW: string = `RCON${Math.floor(Math.random() * 100000)}`;

    private socket: Socket | undefined;
    private connection: Connection | undefined;

    private connected: boolean = false;

    private connectionErrorCounter: number = 0;

    private duplicateMessageCache: string[] = [];
    private duplicateMessageCacheSize: number = 3;

    private stateListener?: Listener;

    public constructor(
        loggerFactory: LoggerFactory,
        private manager: Manager,
        private eventBus: EventBus,
        @inject(InjectionTokens.fs) private fs: FSAPI,
        @inject(InjectionTokens.rconSocket) private socketFactory: RCONSOCKETFACTORY,
    ) {
        super(loggerFactory.createLogger('RCON'));
    }

    public isConnected(): boolean {
        return this.connected;
    }

    private createSocket(): Socket {
        return this.socketFactory();
    }

    public async start(skipServerWait?: boolean): Promise<void> {

        this.connectionErrorCounter = 0;

        const serverCfg = await this.manager.getServerCfg();
        if (serverCfg?.BattlEye === 0) {
            return;
        }

        // get free listening port
        const openListeningPort = await new Promise<number | null>((r) => {
            const tempSocket = dgram.createSocket('udp4');
            tempSocket.bind(() => {
                const openUdpPort = tempSocket.address()?.port;
                tempSocket.close();
                r(openUdpPort);
            });
        });

        if (!openListeningPort) {
            throw new Error('Could not find open UDP Port for Listener');
        }

        // create socket
        this.socket = this.createSocket();

        this.socket.on('listening', (socket) => {
            const addr = socket.address();
            this.log.log(LogLevel.IMPORTANT, `Listening on ${typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`}`);
        });

        this.socket.on('received', (resolved, packet /* , buffer, connection, info */) => {
            this.log.log(LogLevel.DEBUG, `received`, packet);
        });

        this.socket.on('sent', (packet /* , buffer, bytes, connection */) => {
            this.log.log(LogLevel.DEBUG, `sent`, packet);
        });

        this.socket.on('error', (err) => {
            this.log.log(LogLevel.ERROR, `socket error`, err?.message);
        });

        if (skipServerWait) {
            this.setupConnection();
        } else {
            this.stateListener?.off();
            this.stateListener = this.eventBus.on(
                InternalEventTypes.MONITOR_STATE_CHANGE,
                async (state: ServerState) => {
                    if (this.connection || state !== ServerState.STARTED) return;
                    this.stateListener?.off();
                    this.stateListener = undefined;
                    this.setupConnection();
                },
            );
        }

    }

    private setupConnection(): void {
        // create connection
        this.connection = this.socket.connection(
            {
                name: 'rcon',
                password: this.getRconPassword(),
                ip: this.getRconIP() ? this.getRconIP() : '127.0.0.1',
                port: this.getRconPort(),
            },
            {
                reconnect: true,              // reconnect on timeout
                reconnectTimeout: 500,        // how long (in ms) to wait before trying to reconnect
                keepAlive: true,              // send keepAlive packet
                keepAliveInterval: 10000,     // keepAlive packet interval (in ms)
                timeout: true,                // timeout packets
                timeoutInterval: 1000,        // interval to check packets (in ms)
                serverTimeout: 30000,         // timeout server connection (in ms)
                packetTimeout: 1000,          // timeout packet check interval (in ms)
                packetTimeoutThresholded: 5,  // packets to resend
            },
        );

        this.connection.on('message', (message /* , packet */) => {

            if (this.duplicateMessageCache.includes(message)) {
                this.log.log(LogLevel.DEBUG, `duplicate message`, message);
                return;
            }
            this.duplicateMessageCache.push(message);
            if (this.duplicateMessageCache.length > this.duplicateMessageCacheSize) {
                this.duplicateMessageCache.shift();
            }

            this.log.log(LogLevel.DEBUG, `message`, message);
            this.eventBus.emit(
                InternalEventTypes.DISCORD_MESSAGE,
                {
                    type: 'rcon',
                    message,
                },
            );
        });

        this.connection.on('command', (data, resolved, packet) => {
            this.log.log(LogLevel.DEBUG, `command packet`, packet);
        });

        this.connection.on('disconnected', (reason) => {
            if (reason instanceof Error && reason?.message?.includes('Server connection timed out')) {
                this.log.log(LogLevel.ERROR, `disconnected`, reason.message);
            } else {
                this.log.log(LogLevel.ERROR, `disconnected`, reason);
            }
            this.connected = false;
            this.duplicateMessageCache = [];
        });

        this.connection.on('debug', (data) => {
            this.log.log(LogLevel.DEBUG, 'debug', data);
        });

        this.connection.on('error', async (err) => {
            if (err instanceof Error && err?.message?.includes('Server connection timed out')) {
                this.log.log(LogLevel.ERROR, `connection error`, err.message);

                // restart on connection errors (disabled for now)
                // this.connectionErrorCounter++;
                // if (this.connectionErrorCounter >= 5) {
                //     await this.stop();
                //     void this.start(true);
                // }

            } else {
                let logged: any = err;
                if (
                    err instanceof Error
                    && (
                        err?.message?.includes('Packet Error: Cleanup')
                        || err?.message?.includes('PacketCleanupError')
                    )
                ) {
                    logged = err.message;
                }
                this.log.log(LogLevel.ERROR, `connection error`, logged);
            }
        });

        this.connection.on('connected', () => {
            if (!this.connected) {
                this.connected = true;
                this.log.log(LogLevel.IMPORTANT, 'connected');
                void this.sendCommand('say -1 Big Brother Connected.');
            }
        });
    }

    private getRconPassword(): string {
        return (
            this.manager.config?.rconPassword
                ? this.manager.config?.rconPassword
                : this.RND_RCON_PW
        );
    }

    private getRconPort(): number {
        return (
            this.manager.config?.rconPort
                ? this.manager.config?.rconPort
                : 2306
        );
    }

    private getRconIP(): string | undefined {
        return this.manager.config?.rconIP || undefined;
    }

    public createBattleyeConf(): void {
        let battleyePath = this.manager.config?.battleyePath;
        if (!battleyePath) {
            battleyePath = 'battleye';
        }
        let baseDir = this.manager.getServerPath();
        const profiles = this.manager.config?.profilesPath;
        if (profiles) {
            if (path.isAbsolute(profiles)) {
                baseDir = profiles;
            } else {
                baseDir = path.join(baseDir, profiles);
            }
        }
        battleyePath = path.join(baseDir, battleyePath);

        const battleyeConfPath = path.join(battleyePath, 'BEServer_x64.cfg');
        const rConPassword = this.getRconPassword();
        const rConPort = this.getRconPort();
        const rConIP = this.getRconIP();

        this.fs.mkdirSync(battleyePath, { recursive: true });
        try {
            this.fs.readdirSync(battleyePath).forEach((x) => {
                const lower = x.toLowerCase();
                if (lower.includes('beserver') && lower.endsWith('.cfg')) {
                    this.fs.unlinkSync(path.join(battleyePath, x));
                }
            });
        } catch {}
        this.fs.writeFileSync(
            battleyeConfPath,
            [
                `RConPassword ${rConPassword}`,
                `RestrictRCon 0`,
                `RConPort ${rConPort}`,
                ...(rConIP ? [`RConIP ${rConIP}`] : []),
            ].join('\n'),
        );
    }

    private async sendCommand(command: string): Promise<string | null> {

        if (!this.connection || !this.connected) {
            return null;
        }

        let response: IPacketResponse = null;
        try {
            response = await this.connection.command(command);
            this.log.log(LogLevel.DEBUG, `response to ${response.command}:\n${response.data}`);
        } catch (e) {
            if (typeof e === 'object' && (e?.message as string)?.includes('Server connection timed out')) {
                this.log.log(LogLevel.ERROR, 'Error while executing RCON command: Server connection timed out');
            } else if (
                typeof e === 'object'
                && (
                    e?.message?.includes('Packet Error: Cleanup')
                    || e?.message?.includes('PacketCleanupError')
                )
            ) {
                this.log.log(LogLevel.WARN, 'Error while executing RCON command: Message dropped');
            } else {
                this.log.log(LogLevel.ERROR, 'Error while executing RCON command', e);
            }
        }

        return response?.data ?? null;

    }

    public async stop(): Promise<void> {
        this.stateListener?.off();
        this.stateListener = undefined;

        if (this.connection) {

            this.connection.removeAllListeners();
            if (this.connection.connected) {
                this.connection.on(
                    'error',
                    /* istanbul ignore next */ () => { /* ignore */ },
                );
                this.connection.kill(new Error('Reload'));
                this.connection = undefined;
                this.connected = false;
            }
        }

        if (this.socket) {
            return new Promise<void>((res, rej) => {
                try {
                    this.socket.removeAllListeners();
                    ((this.socket!['socket'] as dgram.Socket) ?? {
                        close: (c) => c(),
                    }).close(() => {
                        this.socket = undefined;
                        res();
                    });
                } catch (e) {
                    rej(e);
                }
            });
        }
    }

    public async getBansRaw(): Promise<string | null> {
        return this.sendCommand('bans');
    }

    public async getBans(): Promise<RconBan[]> {
        const data = await this.getBansRaw();
        if (!data) {
            return [];
        }
        const guidBans = matchRegex(
            /(\d+)\s+([0-9a-fA-F]+)\s([perm|\d]+)\s+([\S ]+)$/gim,
            data,
        )
            ?.map((e) => e.slice(1, e.length - 1)) ?? [];
        const ipBans = matchRegex(
            /(\d+)\s+([0-9\.]+)\s+([perm|\d]+)\s+([\S ]+)$/gim,
            data,
        )
            ?.map((e) => e.slice(1, e.length - 1)) ?? [];

        return [
            ...guidBans
                .map((e) => ({
                    type: 'guid',
                    id: e[1],
                    ban: e[2],
                    time: e[3],
                    reason: e[4],
                })),
            ...ipBans
                .map((e) => ({
                    type: 'ip',
                    id: e[1],
                    ban: e[2],
                    time: e[3],
                    reason: e[4],
                })),
        ];
    }

    public async getPlayersRaw(): Promise<string | null> {
        return this.sendCommand('players');
    }

    public async getPlayers(): Promise<RconPlayer[]> {

        const data = await this.getPlayersRaw();

        if (!data) {
            return [];
        }

        return matchRegex(
            /(\d+)\s+(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+\b)\s+(\d+)\s+([0-9a-fA-F]+)\(\w+\)\s([\S ]+)$/gim,
            data,
        )
            .map((e) => {
                return {
                    id: e[1],
                    ip: e[2],
                    port: e[3],
                    ping: e[4],
                    beguid: e[5],
                    name: e[6]?.replace(' (Lobby)', ''),
                    lobby: !!e[6]?.includes(' (Lobby)'),
                };
            }) ?? [];
    }

    public async kick(player: string): Promise<void> {
        await this.sendCommand(`kick ${player}`);
    }

    public async kickAll(): Promise<void> {
        // await this.sendCommand(`kick -1`);
        const players = await this.getPlayers();
        if (players?.length) {
            await Promise.all(players.map((player) => this.kick(player.id)));
        }
    }

    public async ban(player: string): Promise<void> {
        await this.sendCommand(`ban ${player}`);
    }

    public async removeBan(player: string): Promise<void> {
        await this.sendCommand(`removeban ${player}`);
    }

    public async reloadBans(): Promise<void> {
        await this.sendCommand('reloadbans');
    }

    public async shutdown(): Promise<void> {
        await this.sendCommand('#shutdown');
    }

    public async global(message: string): Promise<void> {
        await this.sendCommand(`say -1 ${message}`);
    }

    public async lock(): Promise<void> {
        await this.sendCommand('#lock');
    }

    public async unlock(): Promise<void> {
        await this.sendCommand('#unlock');
    }

}
