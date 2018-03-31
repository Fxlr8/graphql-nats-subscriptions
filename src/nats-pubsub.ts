import { PubSubEngine } from 'graphql-subscriptions';
import { connect, Client, ClientOpts, SubscribeOptions, NatsError } from 'nats';
import { PubSubAsyncIterator } from './pubsub-async-iterator';
import _ from 'lodash';


export type Path = Array<string | number>;
export type Trigger = string | Path;
export type TriggerTransform = (trigger: Trigger, channelOptions?: object) => string;
export type SubscribeOptionsResolver = (trigger: Trigger, channelOptions?: object) => Promise<SubscribeOptions>;
export type PublishOptionsResolver = (trigger: Trigger, payload: any) => Promise<any>;

export interface NatsPubSubOptions {
    client?: Client;
    subscribeOptions?: SubscribeOptionsResolver;
    publishOptions?: PublishOptionsResolver;
    connectionListener?: (err: Error) => void;
    // onNatsSubscribe?: (id: number, granted: ISubscriptionGrant[]) => void;
    triggerTransform?: TriggerTransform;
    parseMessageWithEncoding?: string;
}

export class NatsPubSub implements PubSubEngine {

    private triggerTransform: TriggerTransform;
    private publishOptionsResolver: PublishOptionsResolver;
    private subscribeOptionsResolver: SubscribeOptionsResolver;
    private natsConnection: Client;

    // { [subId]: {topic, natsSid, onMessage} } -- NATS Subscriptions
    private subscriptionMap: { [subId: number]: [string, Function] };
    // { [topic]: [ subId1, subId2, ...]}
    private subsRefsMap: { [trigger: string]: Array<number> };
    // { [topic]: { natsSid }}
    private natsSubMap: { [trigger: string]: number };
    private currentSubscriptionId: number;
    private parseMessageWithEncoding: string;

    public constructor(options: NatsPubSubOptions = {}) {
        this.triggerTransform = options.triggerTransform || (trigger => trigger as string);

        if (options.client) {
            this.natsConnection = options.client;
        } else {
            const brokerUrl = 'nats://127.0.0.1:4222';
            this.natsConnection = connect(brokerUrl);
        }

        if (options.connectionListener) {
            this.natsConnection.on('connect', options.connectionListener);
            this.natsConnection.on('error', options.connectionListener);
            this.natsConnection.on('disconnect', options.connectionListener);
            this.natsConnection.on('reconnecting', options.connectionListener);
            this.natsConnection.on('reconnect', options.connectionListener);
            this.natsConnection.on('close', options.connectionListener);
        } else {
            this.natsConnection.on('error', console.error);
        }

        this.subscriptionMap = {};
        this.subsRefsMap = {};
        this.natsSubMap = {};
        this.currentSubscriptionId = 0;
        // this.onNatsSubscribe = options.onNatsSubscribe || (() => null);
        this.publishOptionsResolver = options.publishOptions || (() => Promise.resolve({}));
        this.subscribeOptionsResolver = options.subscribeOptions || (() => Promise.resolve({}));
        this.parseMessageWithEncoding = options.parseMessageWithEncoding;
    }

    public publish(trigger: string, payload: any): boolean {
        const message = Buffer.from(JSON.stringify(payload), this.parseMessageWithEncoding);
        this.natsConnection.publish(trigger, message);
        return true;
    }

    public async subscribe(trigger: string, onMessage: Function, options?: object): Promise<number> {
        const triggerName: string = this.triggerTransform(trigger, options);
        const id = this.currentSubscriptionId++;
        this.subscriptionMap[id] = [triggerName, onMessage];

        let refs = this.subsRefsMap[triggerName];
        if (refs && refs.length > 0) {
            const newRefs = [...refs, id];
            this.subsRefsMap[triggerName] = newRefs;
            return await id;
        } else {
            // return new Promise<number>((resolve, reject) => {
                // 1. Resolve options object
                // this.subscribeOptionsResolver(trigger, options).then(subscriptionOptions => {
                    // 2. Subscribing using NATS
                    const subId = this.natsConnection.subscribe(triggerName, (msg) => this.onMessage(triggerName, msg));
                    this.subsRefsMap[triggerName] = [...(this.subsRefsMap[triggerName] || []), id];
                    this.natsSubMap[triggerName] = subId;
                    return await id;
                // });
            // });

        }
    }

    public unsubscribe(subId: number) {
        const [triggerName = null] = this.subscriptionMap[subId] || [];
        const refs = this.subsRefsMap[triggerName];
        const natsSubId = this.natsSubMap[triggerName];
        if (!refs) {
            console.error('there are no subscriptions for triggerName (%s) and natsSid (%s)', triggerName, natsSubId);
            throw new Error(`There is no subscription of id "${subId}"`);
        }
        if (refs.length === 1) {
            this.natsConnection.unsubscribe(natsSubId);
            delete this.natsSubMap[triggerName];
            delete this.subsRefsMap[triggerName];
        } else {
            const index = refs.indexOf(subId);
            const newRefs = index === -1 ? refs : [...refs.slice(0, index), ...refs.slice(index + 1)];
            this.subsRefsMap[triggerName] = newRefs;
        }

        delete this.subscriptionMap[subId];
    }

    public asyncIterator<T>(triggers: string | string[]): AsyncIterator<T> {
        return new PubSubAsyncIterator<T>(this, triggers);
    }

    private onMessage(topic: string, message: Buffer) {
        const subscribers = this.subsRefsMap[topic];

        // Don't work for nothing..
        if (!subscribers || !subscribers.length) {
            return;
        }

        const messageString = message.toString(this.parseMessageWithEncoding);
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(messageString);
        } catch (e) {
            parsedMessage = messageString;
        }

        for (const subId of subscribers) {
            const listener = this.subscriptionMap[subId][1];
            listener(parsedMessage);
        }
    }
}
