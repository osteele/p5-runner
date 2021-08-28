// this is the first line that is used for testing hover
// this is the first line that is used for testing hover

console.info('loading');

function setup() {
    createCanvas(windowWidth, windowHeight);

    console.info('info message');
    console.debug('debug message');
    console.log('log message');
    console.error('error message');
    console.warn('warn message');

    console.info(); // blank line
    console.info('args', 1, 2, null, undefined, false, NaN, Infinity, { a: 1 }, [2, 3], circle, function () { });
    console.info('format: %d < %s.', 1, 2);

    // throw new Error('throw error in setup');
}

function draw() {
    throw new Error('throw error in draw');
}
