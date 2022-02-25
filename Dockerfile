FROM node:16
RUN apt-get update && apt-get install -y \
  zbar-tools \
  ghostscript \
  pdftk \
  && rm -rf /var/lib/apt/lists/*
RUN sed -i '/disable ghostscript format types/,+6d' /etc/ImageMagick-6/policy.xml
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

ARG NODE_ENV
ENV NODE_ENV $NODE_ENV
COPY package.json /usr/src/app/
RUN npm install && npm cache clean --force
COPY . /usr/src/app

CMD [ "npm", "start" ]