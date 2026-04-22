let ioInstance;

const setIO = (io) => {
  ioInstance = io;
};

const getIO = () => ioInstance;

module.exports = { setIO, getIO };