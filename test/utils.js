const expect = require('chai').expect;
const utils = require('../utils');

describe('utils', () => {
  describe('angleToDirection', () => {
    it('converts 0 to empty string', () => {
      expect(utils.angleToDirection(0)).to.equal('');
    });
    it('converts 90 to right', () => {
      expect(utils.angleToDirection(90)).to.equal('right');
    });
    it('converts -90 to left', () => {
      expect(utils.angleToDirection(-90)).to.equal('left');
    });
    it('converts 180 to down', () => {
      expect(utils.angleToDirection(180)).to.equal('down');
    });
    it('converts -180 to down', () => {
      expect(utils.angleToDirection(-180)).to.equal('down');
    });
    it('converts multiples of 90', () => {
      expect(utils.angleToDirection(450)).to.equal('right');
      expect(utils.angleToDirection(-450)).to.equal('left');
      expect(utils.angleToDirection(270)).to.equal('left');
      expect(utils.angleToDirection(-270)).to.equal('right');
    });
    it('converts non multiple of 90 to empty string', () => {
      expect(utils.angleToDirection(275)).to.equal('');
      expect(utils.angleToDirection(-85)).to.equal('');
    });
  });

  describe('pagesToCommands', () => {
    it('converts multiple files multiple order and rotations, ignore remove', () => {
      expect(utils.pagesToCommands({ A: 'a01', B: 'a02' }, [
        {
          src: 'A',
          page: 1,
          cutBefore: false,
          remove: false,
          angle: 0,
          data: { name: 'out1' },
        },
        {
          src: 'A',
          page: 2,
          cutBefore: false,
          remove: true,
          angle: -90,
        },
        {
          src: 'B',
          page: 1,
          cutBefore: false,
          remove: false,
          angle: 0,
        },
        {
          src: 'B',
          page: 2,
          cutBefore: true,
          remove: false,
          angle: 90,
          data: { name: 'abc' },
        }])).to.be.deep.equal(['pdfkit A=a01 B=a02 cat A1 B1 output out1.pdf',
        'pdfkit A=a01 B=a02 cat B2right output abc.pdf']);
    });
    it('removes some files from one pdf', () => {
      expect(utils.pagesToCommands({ A: 'a01' }, [
        {
          src: 'A',
          page: 1,
          cutBefore: true,
          remove: false,
          angle: 0,
          data: { name: 'out1' },
        },
        {
          src: 'A',
          page: 2,
          cutBefore: false,
          remove: true,
          angle: -90,
        },
        {
          src: 'A',
          page: 4,
          cutBefore: false,
          remove: false,
          angle: 0,
        },
        {
          src: 'A',
          page: 7,
          cutBefore: true,
          remove: true,
          angle: 90,
          data: { name: 'abc' },
        }])).to.be.deep.equal(['pdfkit A=a01 cat A1 A4 output out1.pdf']);
    });
  });
});
