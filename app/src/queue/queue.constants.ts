export const EXCHANGE = 'tasks.exchange';
export const ROUTING_KEY = 'task.created';
export const QUEUE = 'tasks_queue';

export const DEAD_LETTER_EXCHANGE = 'tasks.dlx';
export const DEAD_LETTER_QUEUE = 'tasks_queue.dlq';

// How many times a quorum queue will redeliver a nacked message before
// RabbitMQ automatically routes it to DEAD_LETTER_EXCHANGE instead.
export const MAX_DELIVERY_ATTEMPTS = 3;
