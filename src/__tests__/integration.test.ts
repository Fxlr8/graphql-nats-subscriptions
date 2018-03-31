
import { isAsyncIterable } from 'iterall';
import { NatsPubSub } from '../nats-pubsub';
import {
    parse,
    GraphQLSchema,
    GraphQLObjectType,
    GraphQLString, ExecutionResult,
} from 'graphql';
import { withFilter } from 'graphql-subscriptions';
import { subscribe } from 'graphql/subscription';

const FIRST_EVENT = 'FIRST_EVENT';

function buildSchema(iterator) {
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          testString: {
            type: GraphQLString,
            resolve: function(_, args) {
              return 'works';
            },
          },
        },
      }),
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          testSubscription: {
            type: GraphQLString,
            subscribe: withFilter(() => iterator, () => true),
            resolve: root => {
              return 'FIRST_EVENT';
            },
          },
        },
      }),
    });
  }

describe('GraphQL-JS asyncIterator', () => {

    const query = parse(`
    subscription S1 {
        testSubscription
    }
    `);
    const pubsub = new NatsPubSub();
    const origIterator = pubsub.asyncIterator(FIRST_EVENT);
    const returnSpy = jest.spyOn(origIterator, 'return');
    const schema = buildSchema(origIterator);
    const results = subscribe(schema, query) as Promise<AsyncIterator<ExecutionResult>>;
    it('should allow subscriptions', () =>
        results
            .then(ai => {

                expect(isAsyncIterable(ai)).toBeTruthy();

                const r = ai.next();
                pubsub.publish(FIRST_EVENT, {});

                return r;
            })
            .then(res => {
                expect(res.value.data.testSubscription).toEqual('FIRST_EVENT');
            }));

    it('should clear event handlers', () =>

        results
            .then(ai => {
                expect(isAsyncIterable(ai)).toBeTruthy();

                pubsub.publish(FIRST_EVENT, {});

                return ai.return();
            })
            .then(res => {
                expect(returnSpy.mockImplementationOnce).toBeTruthy();
            }));
});
