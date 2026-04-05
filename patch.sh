sed -i -e '/mold/a\
\
    - name: Fix libopenblas symlink\
      run: |\
        sudo mkdir -p /usr/lib/x86_64-linux-gnu/openblas/lib\
        sudo ln -sf /usr/lib/x86_64-linux-gnu/libopenblas.so /usr/lib/x86_64-linux-gnu/openblas/lib/liblibopenblas.so\
        sudo ln -sf /usr/lib/x86_64-linux-gnu/libopenblas.a /usr/lib/x86_64-linux-gnu/openblas/lib/liblibopenblas.a\
        echo "OPENBLAS_PATH=/usr/lib/x86_64-linux-gnu/openblas" >> $GITHUB_ENV\
' .github/workflows/e2e-test.yml
