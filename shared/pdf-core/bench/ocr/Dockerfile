FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr=5.3.0-2 time \
    && rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:016c6a371bb1e4c48fe521908cf3ba3d751fade0ab846ad5d4086b563f5c528c https://raw.githubusercontent.com/tesseract-ocr/tessdata/4767ea922bcc460e70b87b1d303ebdfed0897da8/por.traineddata /models/standard/por.traineddata
ADD --checksum=sha256:c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185/por.traineddata /models/fast/por.traineddata
RUN chmod 644 /models/*/por.traineddata \
    && for model in /models/*; do \
        ln -s /usr/share/tesseract-ocr/5/tessdata/configs "$model/configs"; \
        ln -s /usr/share/tesseract-ocr/5/tessdata/osd.traineddata "$model/osd.traineddata"; \
    done

ENV OMP_THREAD_LIMIT=1 LC_ALL=C.UTF-8
